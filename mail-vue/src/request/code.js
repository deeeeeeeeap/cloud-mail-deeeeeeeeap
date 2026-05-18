import http from '@/axios/index.js';

export function codeList(params) {
    return http.get('/code/list', {params: {...params}})
}

export function codeAllList(params) {
    return http.get('/code/allList', {params: {...params}})
}
