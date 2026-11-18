if exists('b:did_mv_demo_markdown')
  finish
endif
let b:did_mv_demo_markdown = 1
setlocal commentstring=<!--\ %s\ -->
nnoremap <buffer> <LocalLeader>p :Prefix NOTE: <CR>
let b:undo_ftplugin = 'setlocal commentstring< | nunmap <buffer> <LocalLeader>p | unlet! b:did_mv_demo_markdown'
