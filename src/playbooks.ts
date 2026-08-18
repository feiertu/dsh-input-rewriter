/**
 * 加载 skills/*.md 的 playbook 内容。
 *
 * 路径相对包根（`../skills/`）：源码态 `src/playbooks.ts` 与产物态 `lib/index.js`
 * 都位于包内一层，`import.meta.url` 相对解析到同一 `skills/` 目录。
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { SCENES } from './rewrite/engine'
import type { Playbook } from './core'

const SKILLS_DIR = new URL('../skills/', import.meta.url)

/** 读入全部场景 playbook（Markdown 原文），失败即抛，保证 misconfiguration fail-loud。 */
export async function loadPlaybooks(): Promise<readonly Playbook[]> {
  const result: Playbook[] = []
  for (const scene of SCENES) {
    const url = new URL(scene.file, SKILLS_DIR)
    const content = await readFile(fileURLToPath(url), 'utf8')
    if (content.trim().length === 0) {
      throw new Error(`playbook ${scene.file} 为空`)
    }
    result.push({ scene, content })
  }
  return result
}
