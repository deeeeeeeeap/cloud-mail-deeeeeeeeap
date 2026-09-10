import { defineStore } from 'pinia'
import { safeEmailCache, deserializeEmailCache } from '@/utils/email-cache.js'

export const useEmailStore = defineStore('email', {
    state: () => ({
        deleteIds: 0,
        starScroll: null,
        emailScroll: null,
        cancelStarEmailId: 0,
        addStarEmailId: 0,
        contentData: {
            email: null,
            delType: null,
            showStar: true,
            showReply: true,
            showUnread: false
        },
        sendScroll: null,
    }),
    persist: {
        pick: ['contentData'],
        // Rewrite legacy caches after sanitizing them during hydration.
        afterHydrate: ({ store }) => store.$persist(),
        serializer: {
            serialize: (state) => JSON.stringify(safeEmailCache(state)),
            deserialize: deserializeEmailCache,
        },
    },
})
