import { Component, ViewChild, ElementRef } from '@angular/core';
import { Observable, map } from 'rxjs';
import { HttpErrorResponse, HttpEventType } from '@angular/common/http';
import { getHttpErrorMessage } from 'src/app/utils/error-handler';
import { ToastrService } from 'ngx-toastr';
import { GithubUpdateService } from 'src/app/services/github-update.service';
import { SystemApiService } from 'src/app/services/system.service';
import { LiveDataService } from 'src/app/services/live-data.service';
import { LocalStorageService } from 'src/app/local-storage.service';
import { ModalComponent } from '../modal/modal.component';
import { SystemInfo } from 'src/app/generated/models';

const IGNORE_RELEASE_CHECK_WARNING = 'IGNORE_RELEASE_CHECK_WARNING';

@Component({
    selector: 'app-update',
    templateUrl: './update.component.html',
    styleUrls: ['./update.component.scss'],
    standalone: false
})
export class UpdateComponent {

  public firmwareUpdateProgress: number = 0;
  public websiteUpdateProgress: number = 0;

  public checkLatestRelease: boolean = false;
  public latestRelease$: Observable<any>;
  public latestEspMinerAsset$: Observable<any>;

  /** Ergebnis des Versionsvergleichs, sobald die Release-Liste geladen ist. */
  public updateAvailable: boolean = false;
  public latestTag: string = '';
  public downloadProgress: number = 0;
  public downloading: boolean = false;

  public info$: Observable<SystemInfo>;

  @ViewChild('firmwareUpload') firmwareUpload!: ElementRef<HTMLInputElement>;
  @ViewChild('websiteUpload') websiteUpload!: ElementRef<HTMLInputElement>;

  @ViewChild('privacyModal') privacyModal?: ModalComponent;
  @ViewChild('progressModal') progressModal?: ModalComponent;

  public updateTarget: string = '';
  public updateStatus: 'progress' | 'success' | 'error' = 'progress';
  public updateMessage: string = '';

  private currentVersion: string | undefined = undefined;

  constructor(
    private systemService: SystemApiService,
    private liveDataService: LiveDataService,
    private toastrService: ToastrService,
    private githubUpdateService: GithubUpdateService,
    private localStorageService: LocalStorageService,
  ) {
    this.latestRelease$ = this.githubUpdateService.getReleases().pipe(map(releases => {
      return (releases as any)[0];
    }));

    this.latestEspMinerAsset$ = this.latestRelease$.pipe(
      map((release: any) => release?.assets?.find((asset: any) => asset.name === 'esp-miner.bin'))
    );

    // Sobald Release und Geraeteinfo da sind: ist das Release neuer als das,
    // was gerade laeuft?
    this.latestRelease$.subscribe((release: any) => {
      this.latestTag = release?.tag_name ?? '';
      this.updateAvailable = !!this.currentVersion && !!this.latestTag
        && this.githubUpdateService.isNewer(this.latestTag, this.currentVersion);
    });

    this.info$ = this.liveDataService.info$;

    // Reload page if firmware version changes
    this.liveDataService.info$.subscribe(info => {
      if (this.currentVersion === undefined) {
        this.currentVersion = info.version;
      } else if (info.version !== this.currentVersion) {
        window.location.reload();
      }
    });

    // Reload page when device comes back online after a successful update
    this.liveDataService.connected$.subscribe(connected => {
      if (connected && this.updateStatus === 'success') {
        window.location.reload();
      }
    });
  }

  onFileSelected(event: Event, target: 'websiteUpload' | 'firmwareUpload') {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      const file = input.files[0];
      if (target === 'websiteUpload') {
        this.otaWWWUpdate(file);
      } else {
        this.otaUpdate(file);
      }
    }
  }

  /** Neueste OSM-Firmware laden und direkt installieren. Die Datei kommt ueber
   *  unseren Proxy (GitHub sendet keine CORS-Header) und geht dann denselben Weg
   *  wie eine von Hand hochgeladene esp-miner.bin.
   */
  public installLatest(): void {
    if (!this.latestTag || this.downloading) {
      return;
    }
    this.downloading = true;
    this.downloadProgress = 0;

    this.githubUpdateService.downloadAsset(this.latestTag, 'esp-miner.bin').subscribe({
      next: (event: any) => {
        if (event.type === HttpEventType.DownloadProgress) {
          this.downloadProgress = event.total
            ? Math.round((event.loaded / event.total) * 100)
            : 0;
        } else if (event.type === HttpEventType.Response) {
          this.downloading = false;
          const blob: Blob = event.body;
          if (!blob || blob.size < 1024) {
            this.toastrService.error('Downloaded firmware looks wrong, nothing was written.');
            return;
          }
          this.otaUpdate(new File([blob], 'esp-miner.bin'));
        }
      },
      error: (err: any) => {
        this.downloading = false;
        this.toastrService.error(getHttpErrorMessage(err) || 'Could not download the firmware.');
      }
    });
  }

  otaUpdate(file: File) {
    if (this.firmwareUpload) {
      this.firmwareUpload.nativeElement.value = '';
    }

    if (file.name != 'esp-miner.bin') {
      this.toastrService.error('Incorrect file, looking for esp-miner.bin.');
      return;
    }

    this.updateTarget = 'Firmware';
    this.updateStatus = 'progress';
    this.updateMessage = '';
    if (this.progressModal) {
      this.progressModal.isVisible = true;
    }

    this.systemService.performOTAUpdate(file)
      .subscribe({
        next: (event: any) => {
          if (event.type === HttpEventType.UploadProgress) {
            this.firmwareUpdateProgress = Math.round((event.loaded / (event.total as number)) * 100);
          } else if (event.type === HttpEventType.Response) {
            if (event.ok) {
              this.updateStatus = 'success';
              this.updateMessage = 'Firmware updated. The page will reload when the device comes back online.';
            } else {
              this.updateStatus = 'error';
              this.updateMessage = event.statusText || 'An unknown error occurred.';
            }
          }
          else if (event instanceof HttpErrorResponse)
          {
            this.updateStatus = 'error';
            this.updateMessage = getHttpErrorMessage(event);
          }
        },
        error: (err) => {
          this.updateStatus = 'error';
          this.updateMessage = getHttpErrorMessage(err);
        },
        complete: () => {
          this.firmwareUpdateProgress = 0;
        }
      });
  }

  otaWWWUpdate(file: File) {
    if (this.websiteUpload) {
      this.websiteUpload.nativeElement.value = '';
    }

    if (file.name != 'www.bin') {
      this.toastrService.error('Incorrect file, looking for www.bin.');
      return;
    }

    this.updateTarget = 'AxeOS';
    this.updateStatus = 'progress';
    this.updateMessage = '';
    if (this.progressModal) {
      this.progressModal.isVisible = true;
    }

    this.systemService.performWWWOTAUpdate(file)
      .subscribe({
        next: (event: any) => {
          if (event.type === HttpEventType.UploadProgress) {
            this.websiteUpdateProgress = Math.round((event.loaded / (event.total as number)) * 100);
          } else if (event.type === HttpEventType.Response) {
            if (event.ok) {
              this.updateStatus = 'success';
              this.updateMessage = 'AxeOS updated. The page will reload when the device comes back online.';
            } else {
              this.updateStatus = 'error';
              this.updateMessage = event.statusText || 'An unknown error occurred.';
            }
          }
          else if (event instanceof HttpErrorResponse)
          {
            this.updateStatus = 'error';
            this.updateMessage = getHttpErrorMessage(event);
          }
        },
        error: (err) => {
          this.updateStatus = 'error';
          this.updateMessage = getHttpErrorMessage(err);
        },
        complete: () => {
          this.websiteUpdateProgress = 0;
        }
      });
  }

  // https://gist.github.com/elfefe/ef08e583e276e7617cd316ba2382fc40
  public simpleMarkdownParser(markdown: string): string {
    const toHTML = markdown
      .replace(/^#{1,6}\s+(.+)$/gim, '<h4 class="mt-2">$1</h4>') // Headlines
      .replace(/\*\*(.+?)\*\*|__(.+?)__/gim, '<b>$1</b>') // Bold text
      .replace(/\*(.+?)\*|_(.+?)_/gim, '<i>$1</i>') // Italic text
      .replace(/\[(.*?)\]\((.*?)\s?(?:"(.*?)")?\)/gm, '<a href="$2" class="underline text-white" target="_blank">$1</a>') // Markdown links
      .replace(/(https?:\/\/github\.com\/.+\/(.+[^\s])+)/gim, (match, p1, p2) => `<a href="${p1}" target="_blank">${match.includes('/pull/') ? '#' : ''}${p2}</a>`) // Regular links
      .replace(/@([^\s]+)/gim, ' <a href="https://github.com/$1" target="_blank">@$1</a> ') // Username links
      .replace(/^\s*[-+*]\s?(.+)$/gim, '<li>$1</li>') // Unordered list
      .replace(/`([^`]+)`/gim, '<code class="bg-surface-100 rounded px-1">$1</code>') // Code
      .replace(/\r\n\r\n/gim, '<br>'); // Breaks

    return toHTML.trim();
  }

  public handleReleaseCheck(): void {
    if (this.localStorageService.getBool(IGNORE_RELEASE_CHECK_WARNING)) {
      this.checkLatestRelease = true;
    } else {
      if (this.privacyModal) {
        this.privacyModal.isVisible = true;
      }
    }
  }

  public continueReleaseCheck(skipWarning: boolean): void {
    this.checkLatestRelease = true;
    if (this.privacyModal) {
      this.privacyModal.isVisible = false;
    }

    if (!skipWarning) {
      return;
    }

    this.localStorageService.setBool(IGNORE_RELEASE_CHECK_WARNING, true);
  }

  public switchPartition(label: string): void {
    if (confirm(`Set ${label} as the next boot partition? The device will restart to apply this change.`)) {
      this.systemService.switchBootPartition(label).subscribe({
        next: (resp) => {
          this.toastrService.success(resp.message);
        },
        error: (err) => {
          this.toastrService.error(err.error?.message || err.message || 'Failed to switch partition');
        }
      });
    }
  }

  public restart(): void {
    if (confirm('Are you sure you want to restart the device?')) {
      this.systemService.restart().subscribe({
        next: () => {
          this.toastrService.success('Restart command sent.');
        },
        error: (err) => {
          this.toastrService.error(err.error?.message || err.message || 'Failed to restart device');
        }
      });
    }
  }

  public toggleCustomWWW(checked: boolean): void {
    const value = checked ? 1 : 0;
    this.systemService.updateSystem('', { useCustomWWW: value }).subscribe({
      next: () => {
        this.toastrService.success(
          `Web UI source changed to ${checked ? 'Custom' : 'Embedded'}. A device restart is required to apply the change.`,
          'Setting Saved',
          { timeOut: 8000 }
        );
      },
      error: (err) => {
        this.toastrService.error(`Failed to change Web UI source. ${getHttpErrorMessage(err)}`);
      }
    });
  }
}
