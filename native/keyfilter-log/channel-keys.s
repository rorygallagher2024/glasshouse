.syntax unified
.thumb
@ Written into libpreProcess.so (OLED48C54LA, webOS 11.2.0, firmware 43.21.77) at
@ 0x18858, the zeros after .eh_frame in the executable segment's last page, and
@ called from handleKeyBlockByApp in place of its createToast, with r9 the
@ KeyEvent: the key code at +0x24, the event at +0x28 (0 pressed, 1 released,
@ 2 repeated). For keys 402 and 403 (channel up and down) it logs one line per
@ event through the LSM context as NL_INPUT_KEYFILTER_USE, the pair
@ PmLogDaemon's whitelist passes to /var/log/messages. Keeps r4-r11; r0-r3,
@ r12 and lr are the caller's to lose, as they were for createToast.
@ build.py assembles it and fills in the two calls (nop.w here).
stub:
  push {r4, r5, r6, lr}
  sub sp, #8
  ldr.w r4, [r9, #0x24]
  ldr.w r5, [r9, #0x28]
  movw r6, #402
  subs r4, r4, r6
  cmp r4, #1
  bhi done
  cmp r5, #4
  bhi done
  adr.w r0, ctxname
  add r1, sp, #4
  nop.w                       @ blx PmLogGetContext
  ldr r0, [sp, #4]
  cbz r0, done
  add r4, r4, r4, lsl #2      @ code index * 5
  add r4, r4, r5              @ + event
  adr.w r3, table
  add r3, r3, r4, lsl #5      @ rows of 32
  adr.w r2, msgid
  adr.w r1, empty
  str r1, [sp]
  movs r1, #6                 @ info
  nop.w                       @ blx PmLogString_
done:
  add sp, #8
  pop {r4, r5, r6, pc}
  .balign 4
ctxname:
  .asciz "LSM"
  .balign 4
msgid:
  .asciz "NL_INPUT_KEYFILTER_USE"
  .balign 4
empty:
  .asciz ""
  .balign 8
table:
  .ascii "{\"glasshouse_key\":402,\"ev\":0}"
  .space 3
  .ascii "{\"glasshouse_key\":402,\"ev\":1}"
  .space 3
  .ascii "{\"glasshouse_key\":402,\"ev\":2}"
  .space 3
  .ascii "{\"glasshouse_key\":402,\"ev\":3}"
  .space 3
  .ascii "{\"glasshouse_key\":402,\"ev\":4}"
  .space 3
  .ascii "{\"glasshouse_key\":403,\"ev\":0}"
  .space 3
  .ascii "{\"glasshouse_key\":403,\"ev\":1}"
  .space 3
  .ascii "{\"glasshouse_key\":403,\"ev\":2}"
  .space 3
  .ascii "{\"glasshouse_key\":403,\"ev\":3}"
  .space 3
  .ascii "{\"glasshouse_key\":403,\"ev\":4}"
  .space 3
