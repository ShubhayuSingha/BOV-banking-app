# Location: /project_tree.py

import os

# Add the folders you want to completely ignore right here
IGNORE_DIRS = [
    "node_modules", 
    "venv", 
    ".vscode", 
    ".git", 
    "__pycache__", 
    ".next", 
    ".idea", 
    "dist", 
    "build"
]

def print_tree(directory, prefix=""):
    try:
        # Grab everything in the current folder
        items = os.listdir(directory)
    except PermissionError:
        # Edge case: We don't have OS permissions to read this folder
        print(f"{prefix}└── [Access Denied]")
        return
    except FileNotFoundError:
        return

    # Filter out the garbage folders based on the array above
    items = [item for item in items if item not in IGNORE_DIRS]

    # Sort logic: Directories first, then files, all alphabetical. 
    # This makes the tree much easier to read.
    def sort_key(item):
        path = os.path.join(directory, item)
        return (not os.path.isdir(path), item.lower())

    items.sort(key=sort_key)

    for index, item in enumerate(items):
        path = os.path.join(directory, item)
        is_last = index == (len(items) - 1)
        pointer = "└── " if is_last else "├── "

        print(f"{prefix}{pointer}{item}")

        # If it's a directory, recursively dive in
        if os.path.isdir(path):
            # Calculate the prefix for the next level down
            extension = "    " if is_last else "│   "
            print_tree(path, prefix=prefix + extension)

if __name__ == "__main__":
    root_dir = "."
    # Print the root folder name at the very top
    print(os.path.basename(os.path.abspath(root_dir)) + "/")
    print_tree(root_dir)