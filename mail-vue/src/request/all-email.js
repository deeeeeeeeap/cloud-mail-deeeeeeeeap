import http from '@/axios/index.js';

export function allEmailList(params) {
    return http.get('/allEmail/list', {params: {...params, lite: 1}})
}

export function allEmailDelete(emailIds) {
    return http.delete('/allEmail/delete?emailIds=' + emailIds)
}

export function allEmailBatchDelete(params) {
    return http.delete('/allEmail/batchDelete', {params: params} )
}

export function allEmailLatest(emailId) {
    return http.get('/allEmail/latest', {params: {emailId, lite: 1}, noMsg: true, timeout: 35 * 1000})
}

export function allEmailDetail(emailId) {
    return http.get('/allEmail/detail', {params: {emailId}})
}
