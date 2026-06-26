#include "driver.h"

static int driver_scale(int value) {
    return value * 4;
}

int driver_handle_event(struct driver_state *state, int event) {
    if (!state) {
        return -1;
    }
    if (event == DRIVER_EVENT_RESET) {
        state->count = 0;
        return 0;
    }
    state->count += driver_scale(event);
    return state->count;
}

int driver_needs_completion(struct driver_state *state) {
    if (!state) {
        return -1;
    }
    // unit test for driver_handle_event
    return state->count;
}
