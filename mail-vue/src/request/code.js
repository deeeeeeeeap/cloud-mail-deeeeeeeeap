import http from '@/axios/index.js';

export function codeList(params, options = {}) {
    return http.get('/code/list', {...options, params: {...params}})
}

export function codeAllList(params, options = {}) {
    return http.get('/code/allList', {...options, params: {...params}})
}
