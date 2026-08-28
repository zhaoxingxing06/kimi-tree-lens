import subprocess

def risky(x):
    eval(x)
    exec(x)
    subprocess.run("ls", shell=True)
