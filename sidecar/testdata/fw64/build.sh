#!/bin/sh
# Rebuilds fw.bin (checked in, so the tests need no toolchain). Needs clang, ld.lld and llvm-objcopy (brew install lld llvm).
set -e
cd "$(dirname "$0")"
clang --target=aarch64-none-elf -O0 -ffreestanding -fno-pic -nostdlib -c fw.c -o fw.o
ld.lld -T fw.ld -o fw.elf fw.o
llvm-objcopy -O binary fw.elf fw.bin
nm fw.elf | grep -E ' (leaf|main_loop|counter|_start)$' || true
rm -f fw.o fw.elf
