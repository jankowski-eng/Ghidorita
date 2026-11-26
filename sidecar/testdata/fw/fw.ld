ENTRY(main_loop)
MEMORY { FLASH (rx) : ORIGIN = 0x0, LENGTH = 64K  RAM (rwx) : ORIGIN = 0x20000000, LENGTH = 64K }
SECTIONS {
  .vectors : { KEEP(*(.vectors)) } > FLASH
  .text : { *(.text*) *(.rodata*) } > FLASH
  .bss (NOLOAD) : { *(.bss*) *(COMMON) } > RAM
  /DISCARD/ : { *(.ARM.exidx*) *(.comment) *(.ARM.attributes) }
}
