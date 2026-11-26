ENTRY(_start)
SECTIONS {
  . = 0x40200000;
  .text : { *(.text.start) *(.text*) *(.rodata*) *(.data*) }
  . = 0x40300000;
  .bss (NOLOAD) : { *(.bss*) *(COMMON) }
  /DISCARD/ : { *(.comment) *(.note*) *(.eh_frame*) }
}
