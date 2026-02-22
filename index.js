require('dotenv').config();
const { Client, GatewayIntentBits, Partials, Events } = require('discord.js');
const Tesseract = require('tesseract.js');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

const TARGET_CHANNEL_ID = process.env.TARGET_CHANNEL_ID; // The channel ID where the bot will listen

client.once(Events.ClientReady, c => {
    console.log(`Ready! Logged in as ${c.user.tag}`);
});

client.on(Events.MessageCreate, async message => {
    // Ignore messages from bots
    if (message.author.bot) return;

    // Only process messages in the target channel
    if (TARGET_CHANNEL_ID && message.channel.id !== TARGET_CHANNEL_ID) return;

    // Check if the message has an image attachment
    if (message.attachments.size > 0) {
        const attachment = message.attachments.first();

        if (attachment.contentType && attachment.contentType.startsWith('image/')) {
            console.log(`Image received from ${message.author.tag} in ${message.channel.name}`);
            const imageUrl = attachment.url;

            try {
                // Let the user know the bot is processing the image
                const processingMsg = await message.reply('Processing image (OCR)...');

                // Perform OCR on the image URL
                const { data: { text } } = await Tesseract.recognize(
                    imageUrl,
                    'eng', // You can change this to 'fra' or multiple languages if needed
                    { logger: m => console.log(m) }
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

                // 1. Trouver le tag de la guilde (ex: [GE] Galactic-Empire)
                const guildMatch = text.match(/\[([a-zA-Z0-9_-]+)\]/i);

                // 2. Trouver le nom du joueur. Les pseudos OCR sont souvent sur la/les ligne(s) précédant le tag.
                // Cherchons la ligne contenant le tag.
                const lines = text.split('\n').filter(line => line.trim() !== '');
                let playerName = "NomInconnu";

                // On inclut les crochets dans le nom final de la guilde
                let guildTag = guildMatch ? `[${guildMatch[1].trim()}]` : "[GuildeInconnue]";

                if (guildMatch) {
                    const cleanTag = guildMatch[1].trim();
                    const tagLineIndex = lines.findIndex(line => line.includes(`[${cleanTag}]`));

                    if (tagLineIndex > 0) {
                        // Le nom du joueur se trouve généralement 1 ou 2 lignes au-dessus, on prend la première ligne non-vide significative
                        // On prend la ligne juste avant (ou 2 lignes avant si c'est du bruit comme "i")
                        for (let i = tagLineIndex - 1; i >= 0; i--) {
                            // On nettoie la ligne des caractères parasites souvent générés par l'OCR
                            let potentialName = lines[i].replace(/^[a-zA-Z0-9\W]{1,3}\s*\)?\s*/, '').trim();
                            if (potentialName.length > 2) {
                                playerName = potentialName;
                                break;
                            }
                        }
                    }

                    // On s'assure qu'on ne prend pas "Galactic-Empire" comme nom de joueur
                    if (playerName === "NomInconnu" && guildMatch) {
                        // Si pas trouvé au dessus, on essaie de prendre le mot à côté du tag au cas où
                        const nameMatch = text.match(/\[[a-zA-Z0-9_-]+\]\s*([a-zA-Z0-9_\- ]+)/i);
                        if (nameMatch) playerName = nameMatch[1].trim();
                    }

                    // On cherche aussi le numéro de serveur (ex: #1061)
                    let serverNumber = "";
                    const serverMatch = text.match(/#(\d+)/);
                    if (serverMatch) {
                        serverNumber = ` #${serverMatch[1]}`;
                    }

                    await processingMsg.edit(`✅ Text extracted successfully:\n**Guild:** ${guildTag}\n**Player:** ${playerName}\n**Server:** ${serverNumber.trim() || "Not found"}\n\nAssigning role and modifying nickname...`);

                    const member = message.member;

                    if (member) {
                        try {
                            // 1. Manage Role
                            // Find the role in the guild
                            let role = message.guild.roles.cache.find(r => r.name === guildTag);

                            if (!role) {
                                // Create role if it doesn't exist
                                role = await message.guild.roles.create({
                                    name: guildTag,
                                    color: 'Random', // Assign a random color
                                    reason: 'Created automatically by the OCR bot',
                                });
                                await message.channel.send(`The role **${guildTag}** was created because it didn't exist.`);
                            }

                            // Assign the role to the user
                            await member.roles.add(role);

                            // 2. Change Nickname with Server Number appended
                            const newNickname = `${guildTag} ${playerName}${serverNumber}`;
                            // Discord has a 32 character limit on nicknames
                            await member.setNickname(newNickname.substring(0, 32));

                            await message.reply(`🎉 Success! The role **${guildTag}** has been assigned to you and your nickname is now **${newNickname}**.`);

                        } catch (actionError) {
                            console.error("Erreur d'attribution Discord:", actionError);
                            await message.reply(`❌ Extraction succeeded, but a permission error prevents me from updating your role or nickname. Please ensure my role is placed **highest** in the server hierarchy and I have "Manage Roles" and "Manage Nicknames" permissions.`);
                        }
                    } else {
                        await message.reply("Could not find member information.");
                    }

                } else {
                    await processingMsg.edit(`❌ Text extracted, but format not recognized.\nRaw text received:\n\`\`\`text\n${text}\n\`\`\`\n\nPlease ensure the image contains the expected format.`);
                }

            } catch (error) {
                console.error("Error processing image:", error);
                message.reply('An error occurred while analyzing the image.');
            }
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
