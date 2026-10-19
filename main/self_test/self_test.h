#ifndef SELF_TEST_H_
#define SELF_TEST_H_

#include <stdint.h>
#include "esp_err.h"

typedef struct GlobalState GlobalState;

uint16_t self_test_get_frequency_mhz(GlobalState * GLOBAL_STATE);
uint16_t self_test_get_voltage_mv(GlobalState * GLOBAL_STATE);
esp_err_t self_test_init(GlobalState * GLOBAL_STATE);
void self_test_task(void * pvParameters);
void self_test_show_message(GlobalState * GLOBAL_STATE, const char * msg);
void self_test_reset(void);
void self_test_record_nonce(GlobalState * GLOBAL_STATE, double nonce_diff);

#endif
