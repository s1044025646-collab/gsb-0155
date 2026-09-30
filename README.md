# DNA 短读段组装与分支歧义追踪后端

Windows 本地可运行的短读段（short-read）组装后端：**TypeScript + Node.js + 内置 SQLite**。

- 只提供 HTTP API、CLI、虚构 DNA 读段生成器与自动化测试
- **不包含**网页界面、物种树推断，也**不连接**任何真实序列库
- 输入假定方向已统一、只含 `ACGT`（大小写均可，内部转大写）
- 管理对象：读段编号、批次、k 值、覆盖次数、组装图、连续片段（unitig）、报告版本

## 算法要点

- 自行构造有向 de Bruijn 图：节点为 k-mer 的前/后缀 `(k-1)-mer`，每条不同 k-mer 为一条有向边。
- 每条边记录**覆盖量**和全部原始观察（读段 id + k-mer 起始位置）。同一条边被多个读段观察到时只增加覆盖，**不制造假分叉**。
- 从非简单节点（入度或出度 ≠ 1）出发提取**最大非分支路径**形成 unitig；残留的边构成纯环，按字典序最小节点作为确定起点、按出边确定方向导出并标记 `circular`。
- 孤立分量不会被丢弃；环与外部完全不连通时额外标记 `isolated`。
- 重复序列 / 气泡导致的多解**不会任意选路后宣称唯一基因组**：fork（出度>1）和 merge（入度>1）节点输出竞争边及其支撑读段证据。
- 长度与 N50 **只对已产出的 unitig 统计**：这不是完整基因组长度，也不是组装正确率。
- 不同参数（不同 k）保留互相独立的组装结果；相同 `(批次, k, 读段内容指纹)` 的重复请求幂等返回既有结果，不重复计数。
- 短于 k 的读段被记录并排除出图；非法字符逐条记录为 `rejected`；节点数超限时返回 `GRAPH_TOO_LARGE` 并回滚。

## 依赖与环境

- **Node.js >= 22.18（推荐 25.x）**：使用内置的 `node:sqlite`、内置 TypeScript 类型擦除、内置 `node:test`
- **零 npm 依赖**：无需 `npm install`，无需编译

## 数据与进程边界

- 所有数据和临时文件都在项目目录 `data/` 下（可用 `DNA_DATA_DIR` / `DNA_DB_PATH` 覆盖）。
- HTTP 服务只绑定回环地址 `127.0.0.1`，默认端口 `0`（由系统自动分配），端口和 pid 写入 `data/server.pid`、`data/server.port`。
- `start`/`stop` 只管理本项目的服务进程。
- 迁移由 `PRAGMA user_version` 驱动，可重复执行。

## 快速开始

```powershell
# 1) 初始化数据库（幂等）
node src/cli.ts init

# 2) 直接生成一个虚构夹具批次（unique_linear|repeat_region|bubble|pure_cycle|low_coverage_gap）
node src/cli.ts fixture --kind repeat_region --seed 42

# 3) 建图（k=6）
node src/cli.ts assemble --batch 1 --k 6

# 4) 查看覆盖、追查分支、列出片段、核对证据
node src/cli.ts coverage --assembly 1
node src/cli.ts branches --assembly 1
node src/cli.ts branches --assembly 1 --kmer ATCGA --kind merge
node src/cli.ts unitigs --assembly 1
node src/cli.ts verify --assembly 1 --ord 0

# 5) 导出 FASTA、比较不同 k、查看版本化报告
node src/cli.ts export --assembly 1 --out data/unitigs.fa
node src/cli.ts assemble --batch 1 --k 7
node src/cli.ts compare --batch 1
node src/cli.ts report --assembly 1
```

手动批次与 JSON 导入：

```powershell
node src/cli.ts batch --name myrun --description "manual import"
node src/cli.ts import --batch 1 --file examples/reads.json
node src/cli.ts assemble --batch 1 --k 5
```

导入 JSON 形如 `{"reads":[{"readCode":"r1","seq":"ACGT..."}]}`，也接受顶层数组。

## 启动 / 停止 HTTP 服务

```powershell
node src/cli.ts serve            # 自动端口，监听 127.0.0.1
node src/cli.ts serve --port 8123
node src/cli.ts stop             # 读取 data/server.pid，只停本项目进程
```

或 `npm start` / `npm run stop`。启动后健康检查：`GET http://127.0.0.1:<port>/health`。

## 可重复端到端演示

```powershell
npm run demo
```

演示使用固定随机种子（42），在 `data/demo/` 下重建数据库，依次跑完全部五类夹具、
建图、覆盖、分支追查、证据核对、跨 k 比较与幂等复现。

## 自动化测试

```powershell
npm test
```

测试使用临时目录中的独立 SQLite 文件，覆盖：

- 唯一线性序列、重复区、分支气泡、纯环、低覆盖断裂五类夹具
- 同内容不同编号读段
- 每条独立边归属（边观察 = 读段 id + 位置，且互不重复）
- 拼接重叠与 unitig 序列、覆盖计数（同边多次观察不累加分叉）
- 确定性（确定起点/方向、重复构建一致）与历史复现（关闭后重开持久化）
- 非法字符、短于 k、图过大、空批次、非法 k 等失败路径
- 导入与建图事务回滚、重复导入/建图/报告的幂等
- HTTP API 的参数校验、错误码、分页、404/422、坏 JSON

测试中的时间通过固定时钟注入，随机通过种子注入（mulberry32）。

## HTTP API 摘要

列表接口支持 `?limit=`（默认 50，最大 500）与 `?offset=`。错误返回
`{"error":{"code","message","details"}}`，状态码：422 校验/输入问题、404 不存在、409 冲突、500 内部错误。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/batches` | `{name, description?}` 创建批次 |
| GET | `/batches` / `/batches/:id` | 批次列表/详情 |
| GET | `/batches/:id/reads` | 分页读段 |
| POST | `/batches/:id/reads` | `{reads:[{readCode,seq}], minLength?}` 幂等导入 |
| POST | `/batches/:id/assemblies` | `{k, maxNodes?}` 建图（幂等） |
| GET | `/batches/:id/assemblies` | 该批次不同参数的独立结果 |
| GET | `/batches/:id/compare` | 跨 k 比较 |
| POST | `/fixtures` | `{kind, seed?, batchName?}` 生成虚构夹具 |
| GET | `/assemblies/:id` | 组装摘要 |
| GET | `/assemblies/:id/edges` | 边覆盖（分页） |
| GET | `/assemblies/:id/branches` | 分支证据列表 |
| GET | `/assemblies/:id/branches/:kmer?kind=fork\|merge` | 追查分支来源到读段/位置 |
| GET | `/assemblies/:id/unitigs` | unitig 列表 |
| GET | `/assemblies/:id/unitigs/:ord/verify` | 逐条边核对支撑证据 |
| GET | `/assemblies/:id/fasta` | FASTA 导出 |
| GET | `/assemblies/:id/report` | 版本化摘要报告（内容不变不新增版本） |

## 目录结构

```
src/
  db.ts                    SQLite 连接 + 可重复迁移
  errors.ts util.ts        错误码、校验、时钟、可注入 PRNG
  server.ts                HTTP API（校验、错误码、分页、仅回环）
  cli.ts                   命令行入口
  demo.ts                  可重复端到端演示
  services/
    batches.ts             批次、幂等导入（事务 + 回执）
    assembler.ts           de Bruijn 图、unitig、分支、N50
    queries.ts             覆盖/追查/核对/比较/报告版本
    generator.ts           五类虚构夹具生成器
test/                      node:test 自动化测试
examples/reads.json        导入示例
data/                      数据库、pid/port、临时与演示文件（运行时生成）
```
