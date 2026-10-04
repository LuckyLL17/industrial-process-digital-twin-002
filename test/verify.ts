import assert from 'node:assert/strict';
import { app } from '../src/index.ts';

let pass = 0;
const results: string[] = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); pass++; results.push(`PASS  ${name}`); }
  catch (e: any) { results.push(`FAIL  ${name}\n      ${e?.message?.replace(/\n/g, '\n      ')}`); }
}
const post = (url: string, body?: unknown) => app.inject({ method: 'POST', url, payload: body });

// 参数集设计要点：
//  pump 合法集 pressure=3.4 / flow=122 在 pump 窗口内、但超出 reactor-01 窗口（3.2 / 120）
//  heater 合法集 temperature=150 在 heater 窗口内、但超出 reactor-01 温度窗口（82）
//  这些“跨窗口合法”参数若仍被 reactor-01 校验就会被误拒
const cases = [
  {
    asset: 'reactor-01', legal: { temperature: 75, pressure: 2.7, flow: 108 },
    illegal: { temperature: 100, pressure: 2.7, flow: 108 }, illegalKey: 'temperature',
    missingKey: 'flow', expectVersion: 4, supersedes: 'recipe-r1-v3',
  },
  {
    asset: 'pump-01', legal: { pressure: 3.4, flow: 122, vibration: 1.2 },
    illegal: { pressure: 2.8, flow: 108, vibration: 5 }, illegalKey: 'vibration',
    missingKey: 'vibration', expectVersion: 1, supersedes: null,
  },
  {
    asset: 'heater-01', legal: { temperature: 150, power: 80 },
    illegal: { temperature: 145, power: 150 }, illegalKey: 'power',
    missingKey: 'power', expectVersion: 1, supersedes: null,
  },
];

for (const c of cases) {
  // 1. 创建：合法参数 -> pending-approval
  const okCreate = await post('/api/recipes', { assetId: c.asset, parameters: c.legal });
  await check(`${c.asset} 创建合法配方 -> pending-approval`, async () => {
    assert.equal(okCreate.statusCode, 200);
    assert.equal(okCreate.json().status, 'pending-approval');
    assert.deepEqual(okCreate.json().risk.violations, []);
  });
  const okRecipe = okCreate.json();

  // 版本与既有版本链
  await check(`${c.asset} 版本号=${c.expectVersion} / supersedes=${c.supersedes ?? 'null'}`, async () => {
    assert.equal(okRecipe.version, c.expectVersion);
    assert.equal(okRecipe.supersedes, c.supersedes);
  });

  // 2. 创建：越界参数 -> rejected（HTTP 200 落库，状态 rejected）
  const badCreate = await post('/api/recipes', { assetId: c.asset, parameters: c.illegal });
  await check(`${c.asset} 创建越界配方 -> rejected`, async () => {
    assert.equal(badCreate.statusCode, 200);
    assert.equal(badCreate.json().status, 'rejected');
    assert.ok(badCreate.json().risk.violations.some((v: string) => v.startsWith(c.illegalKey)),
      JSON.stringify(badCreate.json().risk.violations));
  });
  const badRecipe = badCreate.json();

  // 3. 审批：越界配方 -> 409；再次审批结果稳定一致
  const approveBad = await post(`/api/recipes/${badRecipe.id}/approve`, { approvedBy: 'pe' });
  const approveBad2 = await post(`/api/recipes/${badRecipe.id}/approve`, { approvedBy: 'pe' });
  await check(`${c.asset} 审批越界配方 -> 409 且可重复结果稳定`, async () => {
    assert.equal(approveBad.statusCode, 409);
    assert.equal(approveBad2.statusCode, 409);
    assert.equal(approveBad.json().error, 'recipe violates operating envelope');
    assert.ok(approveBad.json().violations.some((v: string) => v.startsWith(c.illegalKey)));
  });

  // 4. 审批：合法配方 -> approved；重复审批 -> 409 already approved
  const approveOk = await post(`/api/recipes/${okRecipe.id}/approve`, { approvedBy: 'pe' });
  const approveAgain = await post(`/api/recipes/${okRecipe.id}/approve`, { approvedBy: 'pe' });
  await check(`${c.asset} 审批合法配方 -> approved`, async () => {
    assert.equal(approveOk.statusCode, 200);
    assert.equal(approveOk.json().status, 'approved');
    assert.equal(approveOk.json().approvedBy, 'pe');
  });
  await check(`${c.asset} 重复审批 -> 409 already approved（稳定结果）`, async () => {
    assert.equal(approveAgain.statusCode, 409);
    assert.equal(approveAgain.json().error, 'recipe already approved');
    assert.equal(approveAgain.json().status, 'approved');
  });

  // 5. what-if：无覆盖 -> 无越界；覆盖成越界 -> violations 命中同一参数
  const wiOk = await post(`/api/recipes/${okRecipe.id}/what-if`, {});
  const wiBad = await post(`/api/recipes/${okRecipe.id}/what-if`, { overrides: c.illegal });
  await check(`${c.asset} what-if 合法工况无 violations`, async () => {
    assert.equal(wiOk.statusCode, 200);
    assert.deepEqual(wiOk.json().risk.violations, []);
    for (const [k, u] of Object.entries(wiOk.json().units)) assert.equal(typeof u, 'string', `unit ${k}`);
    for (const [k, v] of Object.entries(wiOk.json().estimated)) assert.ok(Number.isFinite(v as number), `estimated.${k} 为有限数，实际=${v}`);
  });
  await check(`${c.asset} what-if 越界工况报 ${c.illegalKey}`, async () => {
    assert.equal(wiBad.statusCode, 200);
    assert.ok(wiBad.json().risk.violations.some((v: string) => v.startsWith(c.illegalKey)),
      JSON.stringify(wiBad.json().risk.violations));
  });
  // what-if 非法 overrides 类型 -> 400
  const wiMalformed = await post(`/api/recipes/${okRecipe.id}/what-if`, { overrides: [1, 2] });
  await check(`${c.asset} what-if overrides 非对象 -> 400`, async () => {
    assert.equal(wiMalformed.statusCode, 400);
  });

  // 6. 控制命令：合法 -> accepted；越界 -> 409，且与 what-if 的 violations 一致
  const cmdOk = await post('/api/control/commands', { assetId: c.asset, parameters: c.legal });
  const cmdBad = await post('/api/control/commands', { assetId: c.asset, parameters: c.illegal });
  await check(`${c.asset} 控制命令合法参数 -> accepted`, async () => {
    assert.equal(cmdOk.statusCode, 200);
    assert.equal(cmdOk.json().status, 'accepted');
    assert.deepEqual(cmdOk.json().risk.violations, []);
  });
  await check(`${c.asset} 控制命令越界 -> 409 且与 what-if 同口径`, async () => {
    assert.equal(cmdBad.statusCode, 409);
    assert.deepEqual(cmdBad.json().violations.sort(), wiBad.json().risk.violations.sort());
  });

  // 7. 参数缺失：创建 400 / 控制命令 400，missing 稳定指出缺哪个参数
  const partial: Record<string, number> = { ...c.illegal }; delete partial[c.missingKey];
  const createMiss = await post('/api/recipes', { assetId: c.asset, parameters: partial });
  const cmdMiss = await post('/api/control/commands', { assetId: c.asset, parameters: partial });
  await check(`${c.asset} 创建缺失 ${c.missingKey} -> 400 missing`, async () => {
    assert.equal(createMiss.statusCode, 400);
    assert.deepEqual(createMiss.json().missing, [c.missingKey]);
  });
  await check(`${c.asset} 控制命令缺失 ${c.missingKey} -> 400 missing`, async () => {
    assert.equal(cmdMiss.statusCode, 400);
    assert.deepEqual(cmdMiss.json().missing, [c.missingKey]);
  });

  // 8. 资产不存在：创建/控制命令 -> 404
  const createNoAsset = await post('/api/recipes', { assetId: 'mixer-99', parameters: c.legal });
  const cmdNoAsset = await post('/api/control/commands', { assetId: 'mixer-99', parameters: c.legal });
  await check(`${c.asset} 对不存在资产创建 -> 404`, async () => {
    assert.equal(createNoAsset.statusCode, 404);
    assert.equal(createNoAsset.json().error, 'asset not found');
  });
  await check(`${c.asset} 对不存在资产发命令 -> 404`, async () => {
    assert.equal(cmdNoAsset.statusCode, 404);
    assert.equal(cmdNoAsset.json().error, 'asset not found');
  });
}

// reactor-01 既有风险算法保持不变：
// 默认参数 coupling=0, pressure 2.7 不大于 3.1 -> riskScore 0；pressure 提到 3.2 -> 0.18
const wiDefault = await post('/api/recipes/recipe-r1-v3/what-if', {});
const wiPressure = await post('/api/recipes/recipe-r1-v3/what-if', { overrides: { pressure: 3.2 } });
await check('reactor-01 既有风险公式：默认 riskScore=0', async () => {
  assert.equal(wiDefault.json().risk.riskScore, 0);
});
await check('reactor-01 既有风险公式：pressure=3.2 时 riskScore=0.18', async () => {
  assert.equal(wiPressure.json().risk.riskScore, 0.18);
});
await check('reactor-01 已审批的种子配方重复审批 -> 409 already approved', async () => {
  const r = await post('/api/recipes/recipe-r1-v3/approve', {});
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().error, 'recipe already approved');
});

// 非反应器资产使用确定性的包络距离分：完全在窗口内 -> 0.1
await check('pump-01 / heater-01 合法风险分确定性 = 0.1', async () => {
  const pump = (await post('/api/recipes', { assetId: 'pump-01', parameters: { pressure: 2.8, flow: 108, vibration: 1.2 } })).json();
  const heater = (await post('/api/recipes', { assetId: 'heater-01', parameters: { temperature: 145, power: 54 } })).json();
  assert.equal(pump.risk.riskScore, 0.1);
  assert.equal(heater.risk.riskScore, 0.1);
});

// 不存在的配方 id：审批 / what-if -> 404
await check('不存在配方 id 审批 -> 404', async () => {
  assert.equal((await post('/api/recipes/no-such-id/approve', {})).statusCode, 404);
});
await check('不存在配方 id what-if -> 404', async () => {
  assert.equal((await post('/api/recipes/no-such-id/what-if', {})).statusCode, 404);
});
// 空 body 基本校验
await check('创建配方缺少 body 字段 -> 400', async () => {
  assert.equal((await post('/api/recipes', { assetId: 'pump-01' })).statusCode, 400);
});
await check('控制命令缺少 body 字段 -> 400', async () => {
  assert.equal((await post('/api/control/commands', { parameters: {} })).statusCode, 400);
});

console.log(results.join('\n'));
console.log(`\n${pass}/${results.length} passed`);
process.exitCode = pass === results.length ? 0 : 1;
await app.close();
