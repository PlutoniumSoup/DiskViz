var currentPath = "C:\\";
var currentData = {};
var allRows = [];
var itemsByIndex = {};
var maxSizeForPercent = 1;
var pieChart = null;
var sortCol = "size";
var sortDir = -1;

function setLoading(on) {
    var el = document.getElementById("global-loading");
    el.classList.toggle("hidden", !on);
}

function loadDrives() {
    setLoading(true);
    fetch("/api/drives")
        .then(function (res) { return res.json(); })
        .then(function (drives) {
            var container = document.getElementById("drives-list");
            container.innerHTML = "";
            drives.forEach(function (d) {
                var div = document.createElement("div");
                div.className = "drive-item";
                div.innerHTML =
                    '<span class="letter">' + d.letter + ':</span> ' + d.percent_used + '%<br>' +
                    '<div class="bar"><span style="width:' + d.percent_used + '%"></span></div>' +
                    d.used_hr + ' / ' + d.total_hr;
                div.onclick = function () { navigateTo(d.path); };
                container.appendChild(div);
            });
        })
        .finally(function () { setLoading(false); });
}

function setScanStatus(text) {
    var el = document.getElementById("scan-status");
    if (!el) return;
    el.textContent = text || "";
    el.classList.toggle("scanning", !!text);
}

function addParentRow(parentPath) {
    if (!parentPath) return;
    var tbody = document.getElementById("file-table-body");
    if (!tbody) return;
    if (tbody.querySelector("tr[data-parent-row='1']")) return;
    var tr = document.createElement("tr");
    tr.dataset.parentRow = "1";
    tr.innerHTML =
        "<td>📁</td>" +
        "<td class=\"name-cell\">..</td>" +
        "<td class=\"size-cell\">—</td>" +
        "<td class=\"progress-cell\"></td>" +
        "<td>Папка</td>" +
        "<td>—</td>";
    tr.querySelector(".name-cell").onclick = function () { navigateTo(parentPath); };
    tbody.insertBefore(tr, tbody.firstChild);
}

function navigateTo(path, forceRefresh) {
    currentPath = path;
    currentData = { current_path: path, parent_path: null, disk_usage: null };
    itemsByIndex = {};
    allRows = [];
    maxSizeForPercent = 1;
    sortCol = "size";
    sortDir = -1;
    renderBreadcrumbs(path);
    document.getElementById("file-table-body").innerHTML = "";
    document.getElementById("current-size").textContent = "…";
    setScanStatus("");
    setLoading(true);
    renderPie([]);

    var url = "/api/list/stream?path=" + encodeURIComponent(path);
    if (forceRefresh) url += "&refresh=1";
    var es = new EventSource(url);
    es.onmessage = function (e) {
        try {
            var msg = JSON.parse(e.data);
            if (msg.type === "meta") {
                currentData.current_path = msg.current_path;
                currentData.parent_path = msg.parent_path;
                currentData.disk_usage = msg.disk_usage;
                if (msg.parent_path) addParentRow(msg.parent_path);
                if (msg.disk_usage) renderDiskUsage(msg.disk_usage);
            } else if (msg.type === "scanning") {
                setScanStatus("Сканируется: " + (msg.path || "").replace(/^[A-Z]:\\/, ""));
            } else if (msg.type === "item") {
                appendRow(msg.item);
            } else if (msg.type === "update") {
                updateRow(msg.index, msg.size, msg.size_hr, msg.no_access);
            } else if (msg.type === "end") {
                document.getElementById("current-size").textContent = msg.current_size_hr || "—";
                renderPie(msg.top_folders || []);
                if (msg.items_order && msg.items_order.length) reorderRows(msg.items_order);
                applySortUi();
                setScanStatus("");
                es.close();
                setLoading(false);
            } else if (msg.type === "error") {
                setScanStatus("");
                alert(msg.error || "Ошибка");
                es.close();
                setLoading(false);
            }
        } catch (err) {}
    };
    es.onerror = function () {
        setScanStatus("");
        es.close();
        setLoading(false);
    };
}

function rescanCurrent() {
    navigateTo(currentPath, true);
}

function progressClass(percent) {
    if (percent >= 60) return "danger";
    if (percent >= 25) return "warn";
    return "";
}

function appendRow(item) {
    if (item.size > maxSizeForPercent) maxSizeForPercent = item.size;
    var maxSize = maxSizeForPercent;
    var percent = (item.no_access || item.is_link || maxSize <= 0) ? 0 : Math.max(2, (item.size / maxSize) * 100);
    var pctClass = progressClass(percent);

    var tr = document.createElement("tr");
    tr.dataset.index = item.index;
    tr.dataset.size = item.size;
    tr.dataset.name = (item.name || "").toLowerCase();
    tr.dataset.type = (item.type || "").toLowerCase();
    tr.dataset.modified = item.modified || "";
    tr.innerHTML =
        "<td>" + (item.is_dir ? "📁" : "📄") + "</td>" +
        "<td class=\"name-cell\">" + escapeHtml(item.name) + "</td>" +
        "<td class=\"size-cell\">" + escapeHtml(item.size_hr) + "</td>" +
        "<td class=\"progress-cell\"><div class=\"progress-bar\"><span class=\"" + pctClass + "\" style=\"width:" + percent + "%\"></span></div></td>" +
        "<td>" + escapeHtml(item.type) + "</td>" +
        "<td>" + escapeHtml(item.modified) + "</td>";
    var nameCell = tr.querySelector(".name-cell");
    if (item.is_dir) {
        nameCell.onclick = function () { navigateTo(item.full_path); };
    } else {
        nameCell.onclick = function () {
            openLocation(item.full_path);
        };
    }
    document.getElementById("file-table-body").appendChild(tr);
    allRows.push(tr);
    itemsByIndex[item.index] = { tr: tr, item: item };
}

function updateRow(index, size, size_hr, no_access) {
    var rec = itemsByIndex[index];
    if (!rec) return;
    rec.item.size = size;
    rec.item.size_hr = size_hr;
    rec.item.no_access = no_access;
    rec.tr.dataset.size = size;
    rec.tr.querySelector(".size-cell").textContent = size_hr;
    if (size > maxSizeForPercent) maxSizeForPercent = size;
    refreshProgressBars();
}

function refreshProgressBars() {
    var maxSize = maxSizeForPercent || 1;
    allRows.forEach(function (row) {
        var size = Number(row.dataset.size) || 0;
        var item = itemsByIndex[row.dataset.index] && itemsByIndex[row.dataset.index].item;
        var noAccess = item && (item.no_access || item.is_link);
        var percent = noAccess ? 0 : Math.max(2, (size / maxSize) * 100);
        var span = row.querySelector(".progress-bar span");
        if (span) {
            span.style.width = percent + "%";
            span.className = progressClass(percent);
        }
    });
}

function reorderRows(items_order) {
    var tbody = document.getElementById("file-table-body");
    var orderMap = {};
    items_order.forEach(function (idx, i) { orderMap[idx] = i; });
    var sorted = allRows.slice().sort(function (a, b) {
        return (orderMap[Number(a.dataset.index)] || 0) - (orderMap[Number(b.dataset.index)] || 0);
    });
    sorted.forEach(function (el) { tbody.appendChild(el); });
}

function parseModified(s) {
    if (!s) return 0;
    var m = s.match(/(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})/);
    if (!m) return 0;
    return new Date(m[3], m[2] - 1, m[1], m[4], m[5]).getTime();
}

function sortBy(col) {
    if (sortCol === col) sortDir = -sortDir;
    else { sortCol = col; sortDir = col === "name" || col === "type" ? 1 : -1; }
    var tbody = document.getElementById("file-table-body");
    var sorted = allRows.slice().sort(function (a, b) {
        var va, vb;
        switch (sortCol) {
            case "name":
                va = (a.dataset.name || "");
                vb = (b.dataset.name || "");
                return sortDir * (va < vb ? -1 : va > vb ? 1 : 0);
            case "size":
                va = Number(a.dataset.size) || 0;
                vb = Number(b.dataset.size) || 0;
                return sortDir * (va - vb);
            case "type":
                va = (a.dataset.type || "");
                vb = (b.dataset.type || "");
                return sortDir * (va < vb ? -1 : va > vb ? 1 : 0);
            case "modified":
                va = parseModified(a.dataset.modified);
                vb = parseModified(b.dataset.modified);
                return sortDir * (va - vb);
            default:
                return 0;
        }
    });
    sorted.forEach(function (el) { tbody.appendChild(el); });
    applySortUi();
}

function applySortUi() {
    var headers = document.querySelectorAll("th[data-sort]");
    headers.forEach(function (th) {
        th.classList.remove("sort-asc", "sort-desc");
        if (th.dataset.sort === sortCol) th.classList.add(sortDir > 0 ? "sort-asc" : "sort-desc");
    });
}

function renderPie(folders) {
    var canvas = document.getElementById("pie-chart");
    if (!canvas) return;
    if (pieChart) { pieChart.destroy(); pieChart = null; }
    if (!folders.length) return;
    var colors = ["#FFD700", "#e6c200", "#ffdf33", "#ffe066", "#ffe699", "#ffecb3", "#fff3cc", "#fff9e6"];
    pieChart = new Chart(canvas.getContext("2d"), {
        type: "pie",
        data: {
            labels: folders.map(function (f) { return f.name.length > 18 ? f.name.slice(0, 15) + "…" : f.name; }),
            datasets: [{
                data: folders.map(function (f) { return f.size; }),
                backgroundColor: colors.slice(0, folders.length),
                borderColor: "#fff",
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: "right", labels: { font: { size: 11 }, padding: 8 } },
                tooltip: {
                    callbacks: {
                        label: function (ctx) {
                            var v = ctx.raw;
                            var total = ctx.dataset.data.reduce(function (a, b) { return a + b; }, 0);
                            var pct = total ? (v / total * 100).toFixed(1) : 0;
                            return ctx.label + ": " + humanReadable(v) + " (" + pct + "%)";
                        }
                    }
                }
            }
        }
    });
}

function humanReadable(bytes) {
    if (bytes === 0) return "0 B";
    var u = ["B", "KB", "MB", "GB", "TB"];
    var i = 0;
    while (bytes >= 1024 && i < u.length - 1) { bytes /= 1024; i++; }
    return bytes.toFixed(1) + " " + u[i];
}

function openLocation(fullPath) {
    if (!fullPath) return;
    try {
        var folder = fullPath.replace(/\\\\[^\\\\]+$/, "");
        var url = "file:///" + folder.replace(/\\\\/g, "/");
        window.open(url, "_blank");
    } catch (e) {
        navigator.clipboard.writeText(fullPath);
        alert("Открыть расположение не удалось, путь скопирован:\n" + fullPath);
    }
}

function renderBreadcrumbs(path) {
    var container = document.getElementById("breadcrumbs");
    container.innerHTML = "";
    var parts = path.split("\\").filter(Boolean);
    var cum = "";
    parts.forEach(function (part, i) {
        if (i === 0 && /^[A-Za-z]:$/.test(part)) {
            cum = part + "\\\\";
        } else {
            cum += (cum ? "\\" : "") + part;
        }
        // Важно: var + замыкание => все обработчики видят последнее значение cum
        var targetPath = cum;
        var a = document.createElement("a");
        a.href = "#";
        a.textContent = part;
        a.onclick = function (e) { e.preventDefault(); navigateTo(targetPath); };
        container.appendChild(a);
        if (i < parts.length - 1) {
            var sep = document.createElement("span");
            sep.textContent = " \\ ";
            sep.style.color = "#999";
            container.appendChild(sep);
        }
    });
}

function renderDiskUsage(usage) {
    if (!usage) return;
    var container = document.getElementById("disk-info");
    container.innerHTML =
        "Диск: " + usage.percent + "%<br>" +
        "<div class=\"bar\"><span style=\"width:" + usage.percent + "%\"></span></div>" +
        usage.used_hr + " / " + usage.free_hr + " свободно";
}

function escapeHtml(s) {
    if (s == null) return "";
    var div = document.createElement("div");
    div.textContent = s;
    return div.innerHTML;
}

function goUp() {
    if (currentData.parent_path) navigateTo(currentData.parent_path);
}

function refresh() {
    navigateTo(currentPath);
}

document.addEventListener("DOMContentLoaded", function () {
    loadDrives();
    navigateTo("C:\\");
    document.querySelectorAll("th[data-sort]").forEach(function (th) {
        th.addEventListener("click", function () { sortBy(th.dataset.sort); });
    });
    document.getElementById("search-input").oninput = function () {
        var term = this.value.toLowerCase();
        allRows.forEach(function (row) {
            var name = (row.querySelector(".name-cell").textContent || "").toLowerCase();
            row.style.display = name.indexOf(term) >= 0 ? "" : "none";
        });
    };
});

function showLargestModal() {
    setLoading(true);
    fetch("/api/largest?path=" + encodeURIComponent(currentPath))
        .then(function (res) { return res.json(); })
        .then(function (files) {
            var tbody = document.getElementById("largest-table-body");
            tbody.innerHTML = "";
            files.forEach(function (f) {
                var tr = document.createElement("tr");
                tr.innerHTML =
                    "<td>" + escapeHtml(f.name) + "</td>" +
                    "<td style=\"font-size:11px;color:#666\">" + escapeHtml(f.rel_path) + "</td>" +
                    "<td class=\"size-cell\">" + escapeHtml(f.size_hr) + "</td>";
                tr.onclick = function () {
                    navigator.clipboard.writeText(f.full_path);
                    alert("Путь скопирован.");
                };
                tbody.appendChild(tr);
            });
            document.getElementById("largest-modal").classList.add("show");
        })
        .finally(function () { setLoading(false); });
}

function hideModal() {
    document.getElementById("largest-modal").classList.remove("show");
}
