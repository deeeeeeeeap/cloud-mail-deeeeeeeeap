import http from '@/axios/index.js';

export function apiKeyList() {
    return http.get('/apiKey/list')
}

export function apiKeyAdd(form) {
    return http.post('/apiKey/add', form)
}

export function apiKeySet(form) {
    return http.put('/apiKey/set', form)
}

export function apiKeyRotate(keyId) {
    return http.post('/apiKey/rotate', {keyId})
}

export function apiKeyDelete(keyId) {
    return http.delete('/apiKey/delete', {params: {keyId}})
}

export function apiKeyRevokeLegacy() {
    return http.delete('/apiKey/legacyToken')
}
