<template>
  <el-config-provider :locale="elementLocale">
    <router-view />
  </el-config-provider>
</template>
<script setup>
import {elementLocale} from "@/i18n/index.js";
</script>
