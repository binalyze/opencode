// A custom tool module that fails at import time. Discovery must log and
// skip it without disturbing the other tools in this directory.
throw new Error("broken custom tool module")

export {}
