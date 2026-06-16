### Example chat

```
> cd dev
> ls -a
.  ..  AetherShips  arch-hypr  Nono-CLI  Nono-Terminal  Sportsee  test.md
> Hi
✦ Hello! How can I help you today?
> Clone and run my rubiks cube project
• git config --global user.name
Iconejey
✦ I see your GitHub username is  Iconejey . I'll search GitHub for your Rubik's Cube project repository under this username.
• curl -s https://api.github.com/users/Iconejey/repos\?per_page\=100 | grep -i full_name
    "full_name": "Iconejey/AetherShips",
    "full_name": "Iconejey/arch-hypr",
    "full_name": "Iconejey/iconejey",
    "full_name": "Iconejey/iconejey.github.io",
    "full_name": "Iconejey/Nored",
    "full_name": "Iconejey/Noservice",
    "full_name": "Iconejey/rubiks-cube",
✦ I found the repository: Iconejey/rubiks-cube. I will now clone it into your workspace at /home/nicolas/dev/rubiks-cube.
• git clone git@github.com:Iconejey/rubiks-cube.git
remote: Compressing objects: 100% (57/57), done.
Receiving objects: 100% (89/89), 23.92 KiB | 272.00 KiB/s, done.
Resolving deltas: 100% (51/51), done.
✦ I will list the contents of the cloned rubiks-cube repository to see the project structure and determine how to run it.
• ls rubiks-cube
node_modules  package.json  package-lock.json  public  server.js
• Read package.json (0-17)
• Read server.js (0-6)
✦ I will now install the project's dependencies.
• npm install
added 66 packages, and audited 67 packages in 644ms
✦ The project is ready to run !
• npm start
Server is running on http://localhost:8029
>
```
