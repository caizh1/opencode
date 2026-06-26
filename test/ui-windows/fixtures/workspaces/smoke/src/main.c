#include "math_utils.h"

int main(void) {
    int value = add_numbers(2, 3);
    return value;
}

int smoke_target(int input) {
    if (input < 0) {
        return 0;
    }
    return input + 1;
}
