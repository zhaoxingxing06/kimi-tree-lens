def helper(x):
    return x


def caller_one():
    v = helper(1)
    return v


def caller_two():
    return helper(2) + helper(3)
