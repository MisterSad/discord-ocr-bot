require('dotenv').config();
const { Client, GatewayIntentBits, Partials, Events } = require('discord.js');
const Tesseract = require('tesseract.js');

// ── Validation du token au démarrage ──────────────────────────────────────────
if (!process.env.DISCORD_TOKEN) {
    console.error('❌ DISCORD_TOKEN is missing from .env — aborting.');
    process.exit(1);
}

// ── Anti-spam : 1 traitement actif par utilisateur à la fois ─────────────────
const processingUsers = new Set();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});


client.once(Events.ClientReady, c => {
    console.log(`Ready! Logged in as ${c.user.tag}`);
});

client.on(Events.MessageCreate, async message => {
    // Ignore messages from bots
    if (message.author.bot) return;

    // Only process messages in channels named '✅-verification'
    if (message.channel.name !== '✅-verification') return;

    // Check if the message has an image attachment
    if (message.attachments.size > 0) {
        const attachment = message.attachments.first();

        // Rate-limit : ignore si l'utilisateur a déjà un traitement en cours
        if (processingUsers.has(message.author.id)) {
            const waitMsg = await message.reply('⏳ Please wait, your previous image is still being processed.');
            setTimeout(async () => {
                try { await message.delete(); } catch (e) {}
                try { await waitMsg.delete(); } catch (e) {}
            }, 5000);
            return;
        }

        // Vérif taille : max 5 MB pour éviter de surcharger Tesseract
        if (attachment.size > 5 * 1024 * 1024) {
            const sizeMsg = await message.reply('❌ Image too large (max 5 MB). Please send a smaller screenshot.');
            setTimeout(async () => {
                try { await message.delete(); } catch (e) {}
                try { await sizeMsg.delete(); } catch (e) {}
            }, 10000);
            return;
        }

        if (attachment.contentType && attachment.contentType.startsWith('image/')) {
            console.log(`Image received from ${message.author.tag} in ${message.channel.name}`);
            const imageUrl = attachment.url;

            processingUsers.add(message.author.id);
            try {
                // Let the user know the bot is processing the image
                const processingMsg = await message.reply('Processing image (OCR)...');
                const messagesToDelete = [message, processingMsg];

                const scheduleCleanup = () => {
                    setTimeout(async () => {
                        for (const msg of messagesToDelete) {
                            try {
                                await msg.delete();
                            } catch (e) {
                                console.error(`Erreur lors de la suppression du message (ID: ${msg.id}):`, e.message);
                            }
                        }
                    }, 10000); // 10 secondes pour lire le message avant suppression
                };

                // Perform OCR on the image URL
                const { data: { text } } = await Tesseract.recognize(
                    imageUrl,
                    'eng', // You can change this to 'fra' or multiple languages if needed
                    { logger: () => {} } // Logger désactivé en production
                );

                console.log(`[OCR Result]:\n${text}`);

                // D'après les logs OCR, le texte ressemble à :
                // fa) LEVLUED
                // i
                // I 5 | [GE] Galactic-Empire Q
                // 
                // OU
                // 
                // ew Natalie
                // iE J) il ¥ [GE] Galactic-Empire o}

                // 1. Découpage du texte en lignes
                const lines = text.split('\n').map(l => l.trim()).filter(line => line !== '');

                let guildTag = "[GuildeInconnue]";
                let playerName = "NomInconnu";
                let serverNumber = "";

                // Trouver le tag de la guilde (ex: [GE] Galactic-Empire)
                let tagLineIndex = -1;
                for (let i = 0; i < lines.length; i++) {
                    const match = lines[i].match(/\[([a-zA-Z0-9_-]+)\]/);
                    if (match) {
                        // Sanitisation : seulement alphanumérique + tirets, max 28 chars (+ crochets = 30)
                        const safeInner = match[1].trim().replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 28);
                        guildTag = `[${safeInner}]`;
                        tagLineIndex = i;
                        break;
                    }
                }

                // 2. Trouver le nom du joueur (sur les lignes précédant le tag)
                if (tagLineIndex !== -1) {
                    for (let i = tagLineIndex - 1; i >= 0; i--) {
                        let line = lines[i];

                        // Nettoyage : enlève les symboles de début et de fin
                        line = line.replace(/^[^a-zA-Z0-9]+/, '').replace(/[^a-zA-Z0-9]+$/, '').trim();

                        // Enlever une éventuelle lettre/icône isolée au début (ex : "i HawkTuah" -> "HawkTuah")
                        const words = line.split(/\s+/);
                        if (words.length > 1 && words[0].length <= 2) {
                            words.shift();
                            line = words.join(' ');
                        }

                        // Le mot "PROFILE" tout en haut ne doit pas être pris comme nom
                        if (line.toUpperCase().includes('PROFILE')) continue;

                        if (line.length >= 3) {
                            // Sanitisation : alphanumérique + espaces + tirets, max 20 chars
                            playerName = line.replace(/[^a-zA-Z0-9 _\-]/g, '').substring(0, 20).trim();
                            break;
                        }
                    }
                }

                // Cas de secours au cas où l'OCR met le nom et le tag sur la même ligne
                if (playerName === "NomInconnu" && tagLineIndex !== -1) {
                    const line = lines[tagLineIndex];
                    const matchBefore = line.match(/^([a-zA-Z0-9_-]+)\s*\[/);
                    if (matchBefore && matchBefore[1].length >= 3) {
                        playerName = matchBefore[1].trim();
                    }
                }

                // 3. Trouver le numéro de serveur (ex: #1061)
                const serverMatch = text.match(/#(\d+)/);
                if (serverMatch) {
                    serverNumber = ` #${serverMatch[1]}`;
                }

                // Vérification si on a trouvé un tag de guilde pour continuer
                const isGuildFound = tagLineIndex !== -1;

                if (isGuildFound) {
                    await processingMsg.edit(`✅ Text extracted successfully:\n**Guild:** ${guildTag}\n**Player:** ${playerName}\n**Server:** ${serverNumber.trim() || "Not found"}\n\nAssigning role and modifying nickname...`);

                    const member = message.member;

                    if (member) {
                        try {
                            // 1. Manage Role
                            // Toujours fetch les rôles d'abord pour éviter les problèmes de cache (si le rôle vient d'être créé ou modifié)
                            await message.guild.roles.fetch();
                            let role = message.guild.roles.cache.find(r => r.name === guildTag);

                            if (!role) {
                                // Create role if it doesn't exist
                                role = await message.guild.roles.create({
                                    name: guildTag,
                                    color: Math.floor(Math.random() * 16777215), // Assigne une couleur aléatoire valide (0x000000 à 0xFFFFFF)
                                    reason: 'Created automatically by the OCR bot',
                                });
                                const roleMsg = await message.channel.send(`The role **${guildTag}** was created because it didn't exist.`);
                                messagesToDelete.push(roleMsg);
                            }

                            // Assign the role to the user
                            await member.roles.add(role);

                            // 2. Change Nickname with Server Number appended
                            const newNickname = `${guildTag} ${playerName}${serverNumber}`;
                            // Discord has a 32 character limit on nicknames
                            await member.setNickname(newNickname.substring(0, 32));

                            const successMsg = await message.reply(`🎉 Success! The role **${guildTag}** has been assigned to you and your nickname is now **${newNickname}**.`);
                            messagesToDelete.push(successMsg);

                        } catch (actionError) {
                            console.error("Erreur d'attribution Discord:", actionError);

                            let errorMessage = `❌ Extraction succeeded, but a permission error prevents me from updating your role or nickname.`;

                            if (actionError.code === 50013) { // Discord "Missing Permissions" code
                                errorMessage += `\n**Important :**\n1. My bot role must be placed **higher** in the server role list than the role **${guildTag}**.\n2. I need "Manage Roles" and "Manage Nicknames" permissions.`;
                            } else {
                                errorMessage += `\nError details: ${actionError.message}`;
                            }

                            const errorMsg = await message.reply(errorMessage);
                            messagesToDelete.push(errorMsg);
                        }
                    } else {
                        const errorMsg = await message.reply("Could not find member information.");
                        messagesToDelete.push(errorMsg);
                    }

                } else {
                    // Sanitisation : évite l'injection de mentions (@everyone, @here, etc.)
                    const safeText = text.replace(/@/g, '\\@').replace(/`/g, "\\`");
                    await processingMsg.edit(`❌ Text extracted, but format not recognized.\nRaw text received:\n\`\`\`text\n${safeText}\n\`\`\`\n\nPlease ensure the image contains the expected format.`);
                }

                scheduleCleanup();

            } catch (error) {
                console.error("Error processing image:", error);
                const catchMsg = await message.reply('An error occurred while analyzing the image.');
                setTimeout(async () => {
                    try { await message.delete(); } catch (e) { console.error("Erreur suppression message utilisateur:", e.message); }
                    try { await catchMsg.delete(); } catch (e) { console.error("Erreur suppression message bot:", e.message); }
                }, 10000);
            } finally {
                // Libère le verrou de l'utilisateur dans tous les cas
                processingUsers.delete(message.author.id);
            }
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
