# TimeRequest · 定时请求监测

一个运行在本机的轻量定时请求监测工具：每隔可配置的时间间隔自动访问指定 URL
（默认 `https://baidu.com`），完整记录**请求包 / 响应包**，并提供美观简约的可视化界面
供你分析状态码、耗时、响应头、响应体与重定向链。

纯 Python 标准库实现，**零第三方依赖**，仅需 Python 3.8+。

## 快速开始

1. 双击 `start.bat`（或命令行执行 `python server.py`）
2. 浏览器会自动打开 http://127.0.0.1:8765
3. 默认已添加目标「百度首页」(https://baidu.com)，每 60 秒检查一次

> 停止服务：在运行窗口按 `Ctrl+C`。

## 功能

- **定时轮询**：间隔可在界面调整（1～86400 秒），支持整体启动 / 暂停，也可单独启用 / 停用某个目标
- **目标管理**：可增加、修改、删除多个监测目标，支持 GET / POST / PUT / DELETE / PATCH / HEAD
  方法，可自定义请求头（JSON）与请求体
- **请求包 / 响应包采集**：每次请求完整记录状态码、总耗时、首字节耗时、请求头、请求体、
  响应头、响应体、重定向链与异常信息，点击记录行即可展开分析
- **可视化界面**：累计统计卡、响应耗时趋势折线图（最近 60 分钟）、状态分布环形图、
  重定向 / 异常提醒、请求记录表
- **数据持久化**：SQLite 落盘（`data.db`），重启不丢数据；自动保留最近 5000 条记录

## 项目结构

```
time_request/
├── server.py      # 服务入口：HTTP API + 静态页面 + 自动打开浏览器
├── monitor.py     # 核心模块：定时调度、请求执行、SQLite 存储
├── web/
│   ├── index.html # 界面结构
│   ├── style.css  # 界面样式
│   └── app.js     # 界面逻辑（数据轮询、图表、详情抽屉）
├── data.db        # SQLite 数据文件（首次启动自动生成）
└── start.bat      # Windows 双击启动脚本
```

## HTTP API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/state` | 运行状态、间隔、目标列表、累计统计 |
| GET | `/api/records?limit=200&target_id=1` | 最近请求记录（列表） |
| GET | `/api/records/{id}` | 单条记录完整请求包 / 响应包 |
| GET | `/api/stats?minutes=60&target_id=1` | 耗时趋势序列 + 状态分布 |
| POST | `/api/targets` | 新增目标 `{name,url,method,headers,body,enabled}` |
| PUT | `/api/targets/{id}` | 修改目标 |
| DELETE | `/api/targets/{id}` | 删除目标 |
| PUT | `/api/config` | 修改配置 `{interval_s}` / `{running}` |
| POST | `/api/run` | 立即执行一次检查（可选 `{target_id}`） |

## 自定义

- **端口**：默认端口为8765，如需修改可：`python server.py --port 9000`
- **不自动打开浏览器**：`python server.py --no-open`
- **数据位置**：默认 `data.db` 存于项目目录，删除后重启即重新初始化

## 常见问题

- **端口被占用**：换端口启动，或先关闭占用该端口的程序
- **HTTPS 证书报错**：如目标站点证书异常，可在该目标的「自定义请求头」之外另配，
  属站点自身问题；工具默认不跳过证书校验以保证数据可信
- **记录过多**：自动保留最近 5000 条，无需手动清理
