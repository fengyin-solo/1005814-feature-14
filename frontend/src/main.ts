import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import { initGateDomain } from './api/gate-dispatch'
import './styles/global.css'

// 闸门调度域首次进入时落默认口径与演示单，保证概览页统计也是迁移后的数据。
initGateDomain()

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
