/**
 * 把 6 份 playbook 注册为 dsh skill，供用户在技能目录里发现、按需加载。
 * skills 服务未挂载时跳过注册，不影响改写主链路。
 */

import type { Context } from '@deepseek-ai/cordis'
// 仅引入类型以激活 `Context.skills` 增强。
import type {} from '@deepseek-ai/dsh-skill'
import type { Playbook } from './playbooks'

/** 把 playbook 注册为运行时 skill（name 形如 `input-rewrite-<scene>`）。 */
export function registerPlaybookSkills(ctx: Context, playbooks: readonly Playbook[]): void {
  const skills = ctx.get('skills')
  if (skills === undefined) return
  for (const { scene, content } of playbooks) {
    skills.register({
      name: `input-rewrite-${scene.id}`,
      description: scene.description,
      source: 'runtime',
      content,
    })
  }
}
