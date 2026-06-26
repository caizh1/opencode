int comment_target_add(int left, int right) {
    return left + right;
}

int comment_target_guard(int value) {
    if (value < 0) {
        return 0;
    }
    return value;
}
