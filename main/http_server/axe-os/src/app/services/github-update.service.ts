import { HttpClient, HttpEvent } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { catchError, map, timeout } from 'rxjs/operators';


interface GithubAsset {
  name: string;
  size: number;
  browser_download_url: string;
}

interface GithubRelease {
  id: number;
  tag_name: string;
  name: string;
  prerelease: boolean;
  body?: string;
  assets?: GithubAsset[];
}

/** Woher die Daten kommen:
 *  - Die Release-LISTE holen wir direkt bei GitHub: dort ist CORS erlaubt und die
 *    Antwort kommt in unter einer Sekunde. Antwortet GitHub nicht (Limit von 60
 *    Anfragen je Stunde und IP erreicht), fragen wir unseren Proxy.
 *  - Die Firmware-DATEI muss dagegen ueber unseren Proxy laufen: GitHub sendet
 *    bei Release-Dateien keine CORS-Header, der Browser darf sie also nicht lesen.
 *
 *  Beide Anfragen bekommen ein Zeitlimit. Ohne das haengt die Seite minutenlang,
 *  wenn ein Weg durch eine Netzsperre ins Leere laeuft (statt sofort den anderen
 *  zu nehmen).
 */
const RELEASES_PROXY = 'https://flasher.opensourceminers.de/releases.php?src=bitaxe';
const FIRMWARE_PROXY = 'https://flasher.opensourceminers.de/fw.php';
const GITHUB_RELEASES = 'https://api.github.com/repos/opensourceminers/OSM-OS-Bitaxe/releases';

@Injectable({
  providedIn: 'root'
})
export class GithubUpdateService {

  constructor(
    private httpClient: HttpClient
  ) { }


  public getReleases(): Observable<GithubRelease[]> {
    return this.httpClient.get<GithubRelease[]>(GITHUB_RELEASES).pipe(
      timeout(8000),
      catchError(() => this.httpClient.get<GithubRelease[]>(RELEASES_PROXY).pipe(timeout(15000))),
      map((releases: GithubRelease[]) => releases.filter((release: GithubRelease) => !release.prerelease))
    );
  }

  /** Firmware-Datei eines Releases laden - mit Fortschritt, es sind einige MB. */
  public downloadAsset(tag: string, name: string): Observable<HttpEvent<Blob>> {
    const url = `${FIRMWARE_PROXY}?src=bitaxe&tag=${encodeURIComponent(tag)}&file=${encodeURIComponent(name)}`;
    return this.httpClient.get(url, {
      responseType: 'blob',
      reportProgress: true,
      observe: 'events'
    });
  }

  /** Versionsvergleich fuer Angaben wie "v2.15.3-osm".
   *  Rueckgabe > 0, wenn `candidate` neuer als `current` ist.
   */
  public compareVersions(candidate: string, current: string): number {
    const parts = (v: string) => (v || '')
      .replace(/^v/i, '')
      .split('-')[0]
      .split('.')
      .map(p => parseInt(p, 10) || 0);

    const a = parts(candidate);
    const b = parts(current);

    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const diff = (a[i] || 0) - (b[i] || 0);
      if (diff !== 0) {
        return diff > 0 ? 1 : -1;
      }
    }
    return 0;
  }

  /** Ist das Geraet auf einem aelteren Stand als das angebotene Release? */
  public isNewer(candidateTag: string, currentVersion: string): boolean {
    return this.compareVersions(candidateTag, currentVersion) > 0;
  }
}
