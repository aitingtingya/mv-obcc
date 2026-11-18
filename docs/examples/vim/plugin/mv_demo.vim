" Copy the example directory contents into <vault>/mv-aide/vim/.
if exists('g:loaded_mv_demo')
  finish
endif
let g:loaded_mv_demo = 1
command! -range -nargs=1 Prefix call mv_demo#Prefix(<line1>, <line2>, <q-args>)
nnoremap <expr> <Leader>G line('.') == 1 ? 'G' : 'gg'
inoreabbrev <expr> mva toupper('mv-aide')
