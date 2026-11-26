#!/bin/sh
# Rebuilds fw.bin (checked in, so the tests need no toolchain). Needs Apple clang or LLVM clang plus ld.lld and llvm-objcopy (brew install lld llvm).
set -e
cd "$(dirname "$0")"
clang --target=armv7m-none-eabi -mcpu=cortex-m3 -mthumb -Os -ffreestanding -fno-pic -nostdlib -c fw.c -o fw.o
ld.lld -T fw.ld -o fw.elf fw.o
llvm-objcopy -O binary fw.elf fw.bin
nm fw.elf 2>/dev/null | grep -E ' (work_a|work_b|main_loop|scale|fact|counter)$' || true
rm -f fw.o fw.elf
