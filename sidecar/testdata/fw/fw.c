/* Bare-metal test target for the debugger tests: Cortex-M3 (qemu-system-arm -M lm3s6965evb). A loop that calls two functions,
 * each writing the global `counter` (SRAM 0x20000000). Built by build.sh into fw.bin (flash image at 0x0). */
#include <stdint.h>

volatile uint32_t counter;

__attribute__((noinline)) void work_a(void) { counter += 1; }
__attribute__((noinline)) void work_b(void) { counter += 2; }
__attribute__((noinline)) void main_loop(void) { for (;;) { work_a(); work_b(); } }

__attribute__((section(".vectors"), used)) static void (*const vectors[2])(void) = { (void (*)(void))0x20010000, main_loop };
