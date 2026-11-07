import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn'
import 'dayjs/locale/zh-tw'
import 'dayjs/locale/ja'
import utc from 'dayjs/plugin/utc'
import {useSettingStore} from "@/store/setting.js";
const settingStore = useSettingStore();
dayjs.extend(utc)

// 界面语言 -> dayjs locale
const DAYJS_LOCALES = {
    zh: 'zh-cn',
    'zh-tw': 'zh-tw',
    ja: 'ja',
    en: 'en',
}

// 各语言的相对时间文案和日期格式
const TIME_FORMATS = {
    zh: {
        justNow: '几秒前',
        minutesAgo: (n) => `${n}分钟前`,
        hoursAgo: (n) => `${n}小时前`,
        todayFmt: 'HH:mm',
        yesterdayFmt: '[昨天] HH:mm',
        dayBeforeFmt: '[前天] HH:mm',
        sameYearFmt: 'M月D日',
        otherYearFmt: 'YYYY/M/D',
        detailSameYearFmt: 'YYYY年M月D日 ddd AH:mm',
        detailOtherYearFmt: 'YYYY年M月D日 ddd AH:mm',
        shortSameYearFmt: 'M月D日',
        shortOtherYearFmt: 'YYYY年M月D日',
        shortTimeSameYearFmt: 'M月D日 HH:mm',
        shortTimeOtherYearFmt: 'YYYY年M月D日 HH:mm',
    },
    'zh-tw': {
        justNow: '幾秒前',
        minutesAgo: (n) => `${n}分鐘前`,
        hoursAgo: (n) => `${n}小時前`,
        todayFmt: 'HH:mm',
        yesterdayFmt: '[昨天] HH:mm',
        dayBeforeFmt: '[前天] HH:mm',
        sameYearFmt: 'M月D日',
        otherYearFmt: 'YYYY/M/D',
        detailSameYearFmt: 'YYYY年M月D日 ddd AH:mm',
        detailOtherYearFmt: 'YYYY年M月D日 ddd AH:mm',
        shortSameYearFmt: 'M月D日',
        shortOtherYearFmt: 'YYYY年M月D日',
        shortTimeSameYearFmt: 'M月D日 HH:mm',
        shortTimeOtherYearFmt: 'YYYY年M月D日 HH:mm',
    },
    ja: {
        justNow: '数秒前',
        minutesAgo: (n) => `${n}分前`,
        hoursAgo: (n) => `${n}時間前`,
        todayFmt: 'HH:mm',
        yesterdayFmt: '[昨日] HH:mm',
        dayBeforeFmt: '[一昨日] HH:mm',
        sameYearFmt: 'M月D日',
        otherYearFmt: 'YYYY/M/D',
        detailSameYearFmt: 'M月D日(ddd) HH:mm',
        detailOtherYearFmt: 'YYYY年M月D日(ddd) HH:mm',
        shortSameYearFmt: 'M月D日',
        shortOtherYearFmt: 'YYYY年M月D日',
        shortTimeSameYearFmt: 'M月D日 HH:mm',
        shortTimeOtherYearFmt: 'YYYY年M月D日 HH:mm',
    },
    en: {
        justNow: 'Just now',
        minutesAgo: (n) => `${n} min ago`,
        hoursAgo: (n) => `${n} hour${n > 1 ? 's' : ''} ago`,
        todayFmt: 'hh:mm A',
        yesterdayFmt: 'MMM D',
        dayBeforeFmt: 'MMM D',
        sameYearFmt: 'MMM D',
        otherYearFmt: 'YYYY/MM/DD',
        detailSameYearFmt: 'ddd, MMM D, h:mm A',
        detailOtherYearFmt: 'ddd, MMM D, YYYY, h:mm A',
        shortSameYearFmt: 'MMM D',
        shortOtherYearFmt: 'MMM D, YYYY',
        shortTimeSameYearFmt: 'MMM D, HH:mm',
        shortTimeOtherYearFmt: 'MMM D, YYYY HH:mm',
    },
}

function timeFormats() {
    return TIME_FORMATS[settingStore.lang] || TIME_FORMATS.en
}

dayjs.locale(DAYJS_LOCALES[settingStore.lang] || 'en')

export function fromNow(date) {
    const d = dayjs.utc(date).local();
    const now = dayjs();
    const diffSeconds = now.diff(d, 'second');
    const diffMinutes = now.diff(d, 'minute');
    const diffHours = now.diff(d, 'hour');
    const isToday = now.isSame(d, 'day');
    const fmt = timeFormats();

    if (isToday) {
        if (diffSeconds < 60) return fmt.justNow;
        if (diffMinutes < 60) return fmt.minutesAgo(diffMinutes);
        if (diffHours < 2) return fmt.hoursAgo(diffHours);
        return d.format(fmt.todayFmt);
    }
    if (now.subtract(1, 'day').isSame(d, 'day')) {
        return d.format(fmt.yesterdayFmt);
    }
    if (now.subtract(2, 'day').isSame(d, 'day')) {
        return d.format(fmt.dayBeforeFmt);
    }
    return d.year() === now.year()
        ? d.format(fmt.sameYearFmt)
        : d.format(fmt.otherYearFmt);
}

export function formatDetailDate(time) {
    const d = dayjs.utc(time).local();
    const now = dayjs();
    const fmt = timeFormats();
    return now.year() === d.year()
        ? d.format(fmt.detailSameYearFmt)
        : d.format(fmt.detailOtherYearFmt);
}

// 短日期，如注册密钥的有效期
export function formatShortDate(time) {
    const d = dayjs.utc(time).local();
    const fmt = timeFormats();
    return d.year() === dayjs().year()
        ? d.format(fmt.shortSameYearFmt)
        : d.format(fmt.shortOtherYearFmt);
}

// 短日期加时间，如注册密钥使用记录
export function formatShortDateTime(time) {
    const d = dayjs.utc(time).local();
    const fmt = timeFormats();
    return d.year() === dayjs().year()
        ? d.format(fmt.shortTimeSameYearFmt)
        : d.format(fmt.shortTimeOtherYearFmt);
}

export function tzDayjs(time) {
    return dayjs.utc(time).local()
}

export function toUtc(time) {
    return dayjs(time).utc()
}

export function setExtend(lang) {
    dayjs.locale(DAYJS_LOCALES[lang] || 'en')
}
