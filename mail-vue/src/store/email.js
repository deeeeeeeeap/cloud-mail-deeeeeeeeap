import { defineStore } from 'pinia'

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
        serializer: {
            // 正文 HTML/纯文本不落 localStorage，详情页 onMounted 会重新拉取
            serialize: (state) => {
                const contentData = { ...state.contentData };
                if (contentData.email) {
                    const { content, text, ...rest } = contentData.email;
                    contentData.email = rest;
                }
                return JSON.stringify({ contentData });
            },
            deserialize: JSON.parse,
        },
    },
})
