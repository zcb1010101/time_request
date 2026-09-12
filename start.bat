@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo  TimeRequest 启动中...
echo  界面地址: http://127.0.0.1:8765
echo  停止服务: 关闭此窗口或按 Ctrl+C
echo ============================================
python server.py
pause
