/* Second debugger test target: AArch64 (qemu-system-aarch64 -M virt -cpu cortex-a57 -device loader,file=fw.bin,addr=0x40200000 -device loader,addr=0x40200000,cpu-num=0). -O0 on purpose: leaf() and main_loop() keep
 * their parameters and locals on the stack; leaf's ninth parameter is passed on the stack, which the debugger's "values" read. Built by build.sh into fw.bin (loaded and imported at 0x40200000). */
volatile unsigned int counter;

__attribute__((noinline)) int leaf(int a, int b, int c, int d, int e, int f, int g, int h, int j) { int t = a * 3 + b + c + d + e + f + g + h + j; counter += (unsigned)t; return t; }
__attribute__((noinline)) void main_loop(void) { for (int i = 0;; i++) { int r = leaf(i, 2, 3, 4, 5, 6, 7, 8, 9); counter += (unsigned)r; } }

__asm__(".section .text.start,\"ax\"\n.global _start\n_start: ldr x0, =0x40400000\n mov sp, x0\n b main_loop\n");
