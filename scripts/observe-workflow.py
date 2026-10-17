#!/usr/bin/env python3
"""
**工作流程观测器**：把某条会话的 workprocess 投递序列读出来对账（真机验收用，只读）。

【为什么要有它】"工作流程对不对"这件事只有真机闭环能回答，而闭环的证据散在两处：
  · 归属记录（`~/.dsh/storages/workprocess.json`）——流程/阶段/任务的**当前**状态与耐久回合计数；
  · 会话日志（`~/.dsh/sessions/<ws>/<sid>/session.v4.jsonl.zstd`）——驱动器**投过什么**（来源自署 `work`）。
本脚本把两处拼成一条时间线，并按"一条完整流程该有的里程碑"逐项打勾/打叉。

用法：
    python3 scripts/observe-workflow.py                 # 取最近更新的那条流程
    python3 scripts/observe-workflow.py <session-id>    # 指定会话

退出码：0 = 里程碑齐全；1 = 有缺项（缺项会逐条列出）。
"""
import json
import subprocess
import sys
import glob
import os
from datetime import datetime

HOME = os.path.expanduser('~')
STORAGE = os.path.join(HOME, '.dsh', 'storages', 'workprocess.json')
SESSIONS = os.path.join(HOME, '.dsh', 'sessions')

# 四种投递的提示词标签（驱动器投递时包在标签里；来源都自署 kind='work'）
TAGS = (('<workprocess_round>', '任务轮'), ('<workprocess_plan>', '规划轮'), ('<workprocess_ask>', '确认轮'),
        ('<workprocess_disarmed>', '停手通告'))


def load_records():
    """读归属记录：{scope: {'process': …, 'rounds': …, 'updatedAt': …}}。"""
    with open(STORAGE, encoding='utf-8') as fh:
        raw = json.load(fh)
    out = {}
    for scope, record in (raw.get('tables', {}).get('processes', {}) or {}).items():
        if isinstance(record, dict) and isinstance(record.get('workProcess'), dict):
            out[scope] = {
                'process': record['workProcess'],
                'rounds': (record.get('rounds') or {}).get('started'),
                'updatedAt': record.get('updatedAt'),
            }
    return out


def session_log_path(sid):
    hits = glob.glob(os.path.join(SESSIONS, '*', sid, 'session.v4.jsonl.zstd'))
    return hits[0] if hits else None


def read_events(sid):
    path = session_log_path(sid)
    if path is None:
        return []
    text = subprocess.run(['zstd', '-dc', path], capture_output=True, check=True).stdout.decode('utf-8', 'replace')
    events = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return events


def event_time(event):
    raw = event.get('time') or event.get('timestamp') or event.get('at')
    if isinstance(raw, (int, float)):
        seconds = raw / 1000 if raw > 1e11 else raw
        return datetime.fromtimestamp(seconds).strftime('%m-%d %H:%M:%S')
    return str(raw)[:19]


def message_text(event):
    content = (event.get('data') or {}).get('content')
    if isinstance(content, list):
        return ' '.join(str(part.get('text', '')) for part in content if isinstance(part, dict))
    return str(content or '')


def classify(event):
    """归类一条 `work` 来源的投递：**source 优先**，标签只用来区分"无 round 的那两种"。"""
    source = ((event.get('data') or {}).get('source') or {})
    if isinstance(source.get('round'), int):
        return '任务轮'
    text = message_text(event)
    for tag, label in TAGS:
        if tag in text:
            return label
    # 旧版驱动器（提交 5a0a0c8 之前）的提示词没有标签：只能按来源字段说个大概。
    return '无 round 轮（旧版：规划或确认）' if source.get('stageKey') else '流程级轮（旧版：确认收口）'


def deliveries(events):
    out = []
    for event in events:
        if event.get('type') != 'user/message':
            continue
        source = ((event.get('data') or {}).get('source') or {})
        if source.get('kind') != 'work':
            continue
        out.append({
            'at': event_time(event),
            'kind': classify(event),
            'stage': source.get('stageKey'),
            'task': source.get('taskId'),
            'round': source.get('round'),
        })
    return out


def report(scope, record, rows):
    process = record['process']
    print(f"流程 scope : {scope}")
    print(f"目标       : {process.get('objective')}")
    print(f"修订/收口  : revision={process.get('revision')} closedAt={process.get('closedAt')} "
          f"回合账（累计 started + 逐任务）= {record['rounds']}")
    print("阶段       :")
    for stage in process.get('stages', []):
        tasks = stage.get('tasks', [])
        done = sum(1 for task in tasks if task.get('phase') == 'complete')
        print(f"   - {stage.get('key'):<12} state={stage.get('state'):<7} "
              f"close={stage.get('closePolicy', 'human'):<5} tasks={done}/{len(tasks)} done")
    print(f"\n投递序列（{len(rows)} 条，来源自署 work）：")
    if not rows:
        print("   （无：驱动器没投过任何一轮）")
    for row in rows:
        bits = [row['kind']]
        if row['stage']:
            bits.append(f"stage={row['stage']}")
        if row['task']:
            bits.append(f"task={row['task']}")
        if row['round'] is not None:
            bits.append(f"round={row['round']}")
        print(f"   {row['at']}  " + '  '.join(bits))

    # ── 里程碑对账 ─────────────────────────────────────────────
    # 硬项：缺一项就说明这条流程**没走完**（是结论）。
    # 信息项：出现了是好事，没出现不算故障（规划轮只在"阶段空着"的边界才投）。
    stages = process.get('stages', [])
    kinds = [row['kind'] for row in rows]
    # 回合号**按任务**从 1 起（回合预算按任务计）：跨任务比"单调不重复"是错的——每个任务都从第 1 轮开始。
    per_task = {}
    for row in rows:
        if isinstance(row['round'], int):
            per_task.setdefault(row['task'] or '（无任务）', []).append(row['round'])
    unfinished = [s.get('key') for s in stages if s.get('state') != 'done']
    checks = [
        ('流程有阶段表', bool(stages)),
        ('驱动器投过轮（来源自署 work）', bool(rows)),
        ('每个任务的回合号从 1 起、不重不漏',
         all(sorted(v) == list(range(1, len(v) + 1)) for v in per_task.values())),
        (f'所有阶段已收口（未收口：{unfinished or "无"}）', not unfinished),
        ('流程收口（closedAt 已落）', process.get('closedAt') is not None),
    ]
    notes = [
        ('阶段规划轮出现过', '规划轮' in kinds),
        ('收口确认轮出现过', any(k in ('确认轮', '流程级轮（旧版：确认收口）') for k in kinds)),
    ]
    print("\n里程碑对账（硬项）：")
    for label, ok in checks:
        print(f"   {'✓' if ok else '✗'} {label}")
    print("信息项（不一定出现）：")
    for label, ok in notes:
        print(f"   {'·' if ok else '—'} {label}{'' if ok else '（本次未出现）'}")
    return all(ok for _, ok in checks)


def main():
    wanted = sys.argv[1] if len(sys.argv) > 1 else None
    records = load_records()
    if not records:
        print('存储里还没有任何 workprocess 流程。')
        return 1
    if wanted is None:
        wanted = max(records, key=lambda s: records[s]['updatedAt'] or 0)
        print(f'（未指定会话，取最近更新的那条：{wanted}）\n')
    if wanted not in records:
        print(f'该会话没有流程：{wanted}')
        return 1
    ok = report(wanted, records[wanted], deliveries(read_events(wanted)))
    print('\n结论：' + ('里程碑齐全 ✅' if ok else '有缺项 ✗（见上面打叉的项）'))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
