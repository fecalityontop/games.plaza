let games = [];
let searchTerm = "";
let sortMode = "az";
let theoArmed = true;
window.gameOpen = false;

async function loadGames() {
    let response = await fetch('games.json');
    games = await response.json();
    renderGrid();
}

loadGames();

function visibleGames() {
    let term = searchTerm.trim().toLowerCase();
    let list = games.map(function (game, index) { return { game: game, index: index }; });
    if (term) {
        list = list.filter(function (item) {
            return item.game.name.toLowerCase().includes(term) ||
                   item.game.idname.toLowerCase().includes(term);
        });
    }
    if (sortMode === "az") {
        list.sort(function (a, b) {
            return a.game.name.localeCompare(b.game.name, undefined, { sensitivity: "base" });
        });
    } else {
        list.sort(function (a, b) { return a.index - b.index; });
    }
    return list.map(function (item) { return item.game; });
}

function renderGrid() {
    let shown = visibleGames();
    let gameholder = document.getElementById("games");
    gameholder.innerHTML = "";
    for (let i = 0; i < shown.length; i++) {
        let gameData = shown[i];
        let game = document.createElement("div");
        gameholder.appendChild(game);
        game.className = "game";
        game.addEventListener("click", function(){ play(gameData.idname) });
        let thumbdiv = document.createElement("div");
        game.appendChild(thumbdiv);
        thumbdiv.className = "game-thumb";
        let thumbimg = document.createElement("div");
        thumbdiv.appendChild(thumbimg);
        thumbimg.style.backgroundImage = `url(media/games/${gameData.idname}.png)`
        thumbimg.className = "game-img";
        let gamename = document.createElement("span");
        game.appendChild(gamename);
        gamename.innerHTML = gameData.name;
    }
    document.getElementById("count").textContent =
        shown.length + (shown.length === 1 ? " game" : " games");
}

document.getElementById("search").addEventListener("input", function (event) {
    searchTerm = event.target.value;
    if (searchTerm.trim().toLowerCase() === "theo") {
        if (theoArmed) {
            theo();
            theoArmed = false;
        }
    } else {
        theoArmed = true;
    }
    renderGrid();
});

document.getElementById("sort").addEventListener("change", function (event) {
    sortMode = event.target.value;
    renderGrid();
});

window.addEventListener('pageshow', function (event) {
    if (event.persisted) {
        window.location.reload();
    }
});

function play(path) {
    window.location.href = 'game.html?g=' + encodeURIComponent(path);
}


function theo() {
    if (document.getElementById("theo-overlay")) return;

    let overlay = document.createElement("div");
    overlay.id = "theo-overlay";
    let theoimg = document.createElement("img");
    theoimg.src = "media/theo.png";
    theoimg.draggable = false;
    overlay.appendChild(theoimg);
    document.body.appendChild(overlay);
    document.body.classList.add("theo-open");
    window.gameOpen = true;

    let coonshi = document.createElement("audio");
    coonshi.src = "media/coonshi.mp3";
    coonshi.loop = true;
    document.body.appendChild(coonshi);
    coonshi.play();
}