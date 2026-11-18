function! mv_demo#Prefix(first, last, prefix) abort
  for number in range(a:first, a:last)
    call setline(number, a:prefix . getline(number))
  endfor
endfunction
