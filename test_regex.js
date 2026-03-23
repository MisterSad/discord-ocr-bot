const lines = ['ald AG21', 'aldAG21', 'Lv. AG21', 'Jon Snow', 'Mr Beast', '[YARR] ald AG21 #1064'];

function cleanName(line) {
    let potentialName = line
        .replace(/^(?:[a-zA-Z0-9]{1,3}\s*\)?\s*)/, '')
        .trim();

    if (potentialName.length <= 2) {
        potentialName = line.replace(/^[^a-zA-Z0-9]*[a-zA-Z0-9]\s+/, '').trim();
    }

    potentialName = potentialName.replace(/^[^a-zA-Z0-9\[\]]+|[^a-zA-Z0-9\[\]]+$/g, '');
    return potentialName;
}

for (const line of lines) {
    console.log(`Original: "${line}" -> Cleaned: "${cleanName(line)}"`);
}

function processText(text) {
    const guildMatch = text.match(/\[([a-zA-Z0-9_-]+)\]/i);
    const lines = text.split('\n').filter(line => line.trim() !== '');
    let playerName = "NomInconnu";
    if (guildMatch) {
        const cleanTag = guildMatch[1].trim();
        const tagLineIndex = lines.findIndex(line => line.includes(`[${cleanTag}]`));
        if (tagLineIndex > 0) {
            for (let i = tagLineIndex - 1; i >= 0; i--) {
                let potentialName = cleanName(lines[i]);
                if (potentialName.length > 2) {
                    playerName = potentialName;
                    break;
                }
            }
        }
        if (playerName === "NomInconnu" && guildMatch) {
            const nameMatch = text.match(/\[[a-zA-Z0-9_-]+\]\s*([a-zA-Z0-9_\- ]+)/i);
            if (nameMatch) playerName = nameMatch[1].trim();
        }
    }
    console.log(`Text:\n${text}\nResult: Player = ${playerName}\n---`);
}

processText(`ald AG21\n[YARR] #1064`);
processText(`[YARR] ald AG21 #1064`);

