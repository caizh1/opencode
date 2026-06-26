#pragma once

#define DRIVER_EVENT_RESET 0

struct driver_state {
    int count;
};

int driver_handle_event(struct driver_state *state, int event);
int driver_needs_completion(struct driver_state *state);
