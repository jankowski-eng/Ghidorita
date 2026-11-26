/* Bare-metal test target for the debugger tests: Cortex-M3 (qemu-system-arm -M lm3s6965evb). A loop that calls two functions,
 * each writing the global `counter` (SRAM 0x20000000). Built by build.sh into fw.bin (flash image at 0x0). */
#include <stdint.h>

volatile uint32_t counter;

__attribute__((noinline)) void work_a(void) { counter += 1; }
__attribute__((noinline)) void work_b(void) { counter += 2; }
int scale(int a, int b, int c, int d, int e, int f);
__attribute__((noinline)) void main_loop(void) { for (;;) { work_a(); work_b(); scale((int)counter, 2, 3, 4, 5, 6); } }
/* optnone, six parameters: e and f are passed on the stack, which the debugger's "values" read (defined after main_loop: the addresses of the others do not move) */
__attribute__((noinline, optnone)) int scale(int a, int b, int c, int d, int e, int f) { int u = a * 3 + b + c + d + e + f; counter += (uint32_t)u; return u; }

__attribute__((section(".vectors"), used)) static void (*const vectors[2])(void) = { (void (*)(void))0x20010000, main_loop };
