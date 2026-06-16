import subprocess

def _run_git(cmd: list, repo_path: str) -> dict:
    try:
        result = subprocess.check_output(cmd, cwd=repo_path, text=True, stderr=subprocess.STDOUT)
        return {"success": True, "output": result}
    except subprocess.CalledProcessError as e:
        return {"success": False, "output": e.output}

def get_status(repo_path: str):
    """Returns parsed git status categorized into staged, unstaged, and untracked."""
    res = _run_git(['git', 'status', '-s'], repo_path)
    if not res["success"]:
        return {"error": res["output"], "staged": [], "unstaged": [], "untracked": []}

    staged = []
    unstaged = []
    untracked = []

    for line in res["output"].splitlines():
        if len(line) > 3:
            x = line[0]
            y = line[1]
            file = line[3:].strip()

            if x == '?' and y == '?':
                untracked.append(file)
            else:
                if x != ' ' and x != '?':
                    staged.append(file)
                if y != ' ' and y != '?':
                    unstaged.append(file)

    return {"staged": staged, "unstaged": unstaged, "untracked": untracked}

def get_diff(repo_path: str, filepath: str = None):
    cmd = ['git', 'diff']
    if filepath:
        cmd.append(filepath)
    res = _run_git(cmd, repo_path)
    return {"diff": res["output"] if res["success"] else f"Error: {res['output']}"}

def stage_file(repo_path: str, filepath: str):
    res = _run_git(['git', 'add', filepath], repo_path)
    return {"success": res["success"], "message": res["output"]}

def commit_changes(repo_path: str, message: str):
    res = _run_git(['git', 'commit', '-m', message], repo_path)
    return {"success": res["success"], "message": res["output"]}

def init_repo(repo_path: str):
    res = _run_git(['git', 'init'], repo_path)
    return {"success": res["success"], "message": res["output"]}

def unstage_file(repo_path: str, filepath: str):
    # `git restore --staged` is the modern unstage; works on any tracked path.
    res = _run_git(['git', 'restore', '--staged', filepath], repo_path)
    if not res["success"]:
        res = _run_git(['git', 'reset', 'HEAD', '--', filepath], repo_path)
    return {"success": res["success"], "message": res["output"]}

def discard_file(repo_path: str, filepath: str):
    """Discard unstaged changes to a tracked file (git restore <file>)."""
    res = _run_git(['git', 'restore', '--', filepath], repo_path)
    if not res["success"]:
        res = _run_git(['git', 'checkout', '--', filepath], repo_path)
    return {"success": res["success"], "message": res["output"]}
