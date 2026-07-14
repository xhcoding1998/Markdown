import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { useStudioStore } from './stores/studio'
import './styles.css'
import 'highlight.js/styles/github-dark.css'

async function bootstrap() {
  const pinia = createPinia()
  const app = createApp(App).use(pinia)
  await useStudioStore(pinia).initializeWorkspace()
  app.mount('#app')
}

void bootstrap()
