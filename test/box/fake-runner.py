#!/usr/bin/python3
"""반납 시험용 가짜 러너(rtrun). 모드: sleep(600초 대기), detach(떼어 낸 자손을 남기고 바로 끝남)."""
import os
import subprocess
import sys
import time

w = os.environ["GJC_RT_JOB_DIR"]
with open(os.path.join(w, "ran"), "w") as f:
    f.write("1")
mode = open(os.path.join(w, "mode")).read().strip()
if mode == "detach":
    subprocess.Popen(["setsid", "nohup", "sleep", "777"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                     stderr=subprocess.DEVNULL, start_new_session=True)
    sys.exit(0)
time.sleep(600)
