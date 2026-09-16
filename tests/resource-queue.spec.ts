/**
 * 虎符 L0: 通用竞争资源队列原语(v7.6)——FIFO/同 holder 合并/单一授权点/
 * 授予失败重排/释放唤醒/evict 出队/超时位置。
 */
import { describe, expect, it } from 'vitest'
import { ResourceQueue } from '../src/resource-queue.ts'

interface Box { can: boolean; granted: string[] }

function makeQueue(capacity: number, pollMs = 10) {
  const box: Box = { can: true, granted: [] }
  const queue = new ResourceQueue({
    capacity,
    pollMs,
    defaultTimeoutMs: 2000,
    canGrant: async () => box.can,
    grant: async (holderId: string) => { box.granted.push(holderId) },
  })
  return { queue, box }
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

describe('ResourceQueue (v7.6)', () => {
  it('grants immediately when capacity free', async () => {
    const { queue } = makeQueue(2)
    const r = await queue.acquire('a')
    expect(r.status).toBe('granted')
    expect(queue.grantedCount()).toBe(1)
  })

  it('FIFO: waiters are granted in enqueue order', async () => {
    const { queue, box } = makeQueue(1)
    box.can = false
    const p1 = queue.acquire('a')
    const p2 = queue.acquire('b')
    const p3 = queue.acquire('c')
    await sleep(20)
    expect(queue.waiters().map(w => w.holderId)).toEqual(['a', 'b', 'c'])
    box.can = true
    await queue.release() // pump
    expect((await p1).status).toBe('granted')
    expect(box.granted).toEqual(['a'])
    await queue.release()
    await sleep(30)
    expect((await p2).status).toBe('granted')
    await queue.release()
    await sleep(30)
    expect((await p3).status).toBe('granted')
    expect(box.granted).toEqual(['a', 'b', 'c'])
  })

  it('merges same holderId into one wait position and shares the result', async () => {
    const { queue, box } = makeQueue(1)
    box.can = false
    const p1 = queue.acquire('g-25')
    const p2 = queue.acquire('g-25') // 同题第二个执行者
    await sleep(20)
    expect(queue.waiters().map(w => w.holderId)).toEqual(['g-25'])
    box.can = true
    await queue.release()
    await sleep(30)
    const r1 = await p1
    const r2 = await p2
    expect(r1.status).toBe('granted')
    expect(r2.status).toBe('granted')
    expect(box.granted).toEqual(['g-25']) // 只开了一个资源
  })

  it('single grant point: capacity never exceeded even with concurrent waits', async () => {
    const { queue, box } = makeQueue(1)
    box.can = false
    void queue.acquire('a')
    void queue.acquire('b')
    void queue.acquire('c')
    await sleep(20)
    box.can = true
    for (let i = 0; i < 3; i++) { await queue.release(); await sleep(30) }
    expect(box.granted).toEqual(['a', 'b', 'c'])
    await queue.release() // 释放最后一个授权(c)
    expect(queue.grantedCount()).toBe(0)
  })

  it('grant failure requeues front and retries next pump', async () => {
    const box: Box = { can: true, granted: [] }
    let fail = true
    const queue = new ResourceQueue({
      capacity: 1, pollMs: 10, defaultTimeoutMs: 2000,
      canGrant: async () => true,
      grant: async (holderId: string) => {
        if (fail) { fail = false; throw new Error('platform 409') }
        box.granted.push(holderId)
      },
    })
    const p = queue.acquire('a')
    const r = await p
    expect(r.status).toBe('granted')
    expect(box.granted).toEqual(['a'])
  })

  it('evict removes waiter and lets the next one proceed', async () => {
    const { queue, box } = makeQueue(1)
    box.can = false
    const p1 = queue.acquire('g-25')
    const p2 = queue.acquire('g-26')
    await sleep(20)
    expect(queue.evict('g-25', 'challenge complete')).toBe(true)
    expect((await p1).status).toBe('evicted')
    box.can = true
    await queue.release()
    await sleep(30)
    expect((await p2).status).toBe('granted')
    expect(box.granted).toEqual(['g-26'])
  })

  it('timeout resolves with position', async () => {
    const { queue, box } = makeQueue(1)
    box.can = false
    const p = queue.acquire('a', { timeoutMs: 60 })
    const r = await p
    expect(r.status).toBe('timeout')
    if (r.status === 'timeout') expect(r.position).toBe(1)
  })
})
