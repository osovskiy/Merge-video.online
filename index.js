import * as fs from 'fs';
import * as path from 'path';
import {performance} from 'perf_hooks';

import {spawn} from 'child_process';

import {Telegraf, Markup} from 'telegraf';

import { v4 as uuidv4, validate as uuidValidate } from 'uuid';

let user_map = new Map();
let status_map = new Map();

const keyboard = Markup
	.keyboard([
		['Статус', 'Старт']
	])
	.placeholder('')
	.resize();

const BOT_TOKEN = ''; // ваш токен

//const bot = new Telegraf(process.env.BOT_TOKEN);
const bot = new Telegraf(BOT_TOKEN);

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

async function get_query(ctx) {
	const matches = ctx.message.text.match(/(?<=\s+).+/);

	let query = '';
	if (matches != null) {
		query = matches[0].trim();
	}

	return query;
}

function get_unix_time() {
	return Number(Math.floor(Date.now() / 1000));
}

bot.use(async (ctx, next) => {
	let last_update_id = fs.readFileSync('last_update_id');
	if (ctx.update.update_id > last_update_id) {
		//console.log('[Bot]:', `Processing update ${ctx.update.update_id}`);
		fs.writeFileSync('last_update_id', String(ctx.update.update_id));
		await next(); // runs next middleware
	}
});

async function send_keyboard(ctx, text) {
	await ctx.reply(text, keyboard);
}

bot.start((ctx) => {
	ctx.reply('Bot started', keyboard);
});

function spawn_promise(command, args = [], options = {}, encoding = 'utf-8') {
	return new Promise((resolve, reject) => {
		const params = {command, args, options};

		const child = spawn(command, args, options);

		let stdout;
		let stderr;

		let stdout_chunks = [];
		let stderr_chunks = [];

		if (encoding != null) {
			child.stdout.setEncoding(encoding);
			child.stderr.setEncoding(encoding);
		}

		child.stdout.on('data', (chunk) => {
			stdout_chunks.push(chunk);
		});

		child.stdout.on('end', () => {
			if (encoding != null) {
				stdout = stdout_chunks.join('');
			}
			else {
				stdout = Buffer.concat(stdout_chunks);
			}
		});

		child.stderr.on('data', (chunk) => {
			stderr_chunks.push(chunk);
		});

		child.stderr.on('end', () => {
			if (encoding != null) {
				stderr = stderr_chunks.join();
			}
			else {
				stderr = Buffer.concat(stderr_chunks);
			}
		});

		let error = null;

		child.stdout.on('error', (err) => error = err);
		child.stderr.on('error', (err) => error = err);

		child.on('error', (err) => {
			error = err;
		});

		child.on('close', (code) => {
			if (error != null) {
				reject({error, code, params, stdout, stderr});
				return;
			}
			if (code == 0) {
				resolve({error, code, params, stdout, stderr});
			}
			else {
				reject({error, code, params, stdout, stderr});
			}
			return;
		});
	});
}

function choose_res(videos) {
	let maps = [];
	for (const video of videos) {
		let map = new Map();
		for (const format of video.formats) {
			const key = JSON.stringify({'width': format.width, 'height': format.height});
			let array;
			if (map.has(key)) {
				array = map.get(key);
			}
			else {
				array = [];
				map.set(key, array);
			}
			array.push(format);
		}
		maps.push(map);
	}
	let unique = new Set();
	for (const map of maps) {
		for (const item of map.keys()) {
			unique.add(item);
		}
	}
	let resolutions = [];
	for (const unique_item of unique.keys()) {
		let count = 0;
		for (const map of maps) {
			if (map.has(unique_item)) {
				count++;
			}
		}
		let resolution = JSON.parse(unique_item);
		resolutions.push({resolution, count});
	}
	let resolution = null;
	let album = resolutions.filter(item => item.resolution.width > item.resolution.height);
	if (album.length > 0) {
		album.sort((a, b) => b.resolution.width - a.resolution.width);
		console.log('album', album);
		const tmp = album.find(item => item.count == videos.length);
		if (tmp !== undefined) {
			({resolution} = tmp); 
		}
	}
	else {
		let portrait = resolutions.filter(item => item.resolution.height > item.resolution.width);
		portrait.sort((a, b) => b.resolution.height - a.resolution.height);
		console.log('portrait', portrait);
		const tmp = portrait.find(item => item.count == videos.length);
		if (tmp !== undefined) {
			({resolution} = tmp); 
		}
	}
	return resolution;
}

bot.hears('Старт', async (ctx) => {
	if (!user_map.has(ctx.message.from.id)) {
		await ctx.reply('Список пуст', keyboard);
		return;
	}

	const list = Array.from(user_map.get(ctx.message.from.id).values());

	if (list.length == 0) {
		await ctx.reply('Список пуст', keyboard);
		return;
	}

	status_map.set(ctx.message.from.id, 'in_progress');
	await ctx.reply('Ожидайте...', keyboard);

	const userId = ctx.message.from.id;
	const chatId = ctx.message.chat.id;

	const on_resolve = link => {
		console.log(link);
		bot.telegram.sendMessage(chatId, `<a href="${link}">${link}</a>`, {parse_mode: 'HTML'});
		user_map.delete(userId);
		status_map.delete(userId);
	};

	const on_reject = error => {
		if (error.user_msg != null) {
			bot.telegram.sendMessage(chatId, error.user_msg);
		}
		else {
			console.error(error);
			bot.telegram.sendMessage(chatId, 'Внутренняя ошибка');
		}
		user_map.delete(userId);
		status_map.delete(userId);
	};

	const promise = (async () => {
		let videos = [];

		for (const video of list) {
			let result = await spawn_promise('youtube-dl', ['--dump-json', video.url]);
			let metadata = JSON.parse(result.stdout);
			let video_meta = {
				'url': video.url,
				'id': metadata.id,
				'title': metadata.title,
				'formats': metadata.formats
			};
			videos.push(video_meta);
			await sleep(100);
		}

		let resolution = choose_res(videos);

		console.log('resolution', resolution);

		let format;

		if (resolution != null) {
			format = `bestvideo[width=${resolution.width}][height=${resolution.height}]+bestaudio/best[width=${resolution.width}][height=${resolution.height}]`;
		}
		else {
			throw {'user_msg': 'Не удалось подобрать разрешение'};
		}

		console.log('format', format);

		const dir = uuidv4();
		await spawn_promise('mkdir', [dir]);

		let filenames = [];

		for (const video of list) {
			await spawn_promise('youtube-dl', ['-f', format, '--merge-output-format', 'mkv', '-o', '%(id)s.%(ext)s', video.url], {'cwd': path.join(process.cwd(), dir)});
			const result = await spawn_promise('youtube-dl', ['--get-filename', '-f', format, '--merge-output-format', 'mkv', '-o', '%(id)s.%(ext)s', video.url]);
			filenames.push(result.stdout.trim());
		}

		const out_filename = `${(new Date()).toISOString().replaceAll(':', '-').replaceAll('.', '-')}.mkv`;

		let args = [];

		for (const filename of filenames) {
			args.push('-i', filename);
		}

		args.push('-filter_complex');

		let filter = '';

		for (let i = 0; i < filenames.length; i++) {
			filter += `[${i}:v:0][${i}:a:0]`;
		}

		filter += `concat=n=${filenames.length}:v=1:a=1[outv][outa]`;

		args.push(filter);

		args.push('-map', '[outv]', '-map', '[outa]');

		args.push('-c:v', 'libx264');

		args.push('-c:a', 'libopus');
		args.push('-b:a', '160k');

		args.push(out_filename);

		await spawn_promise('ffmpeg', args, {'cwd': path.join(process.cwd(), dir)});

		for (const filename of filenames) {
			try {
				await fs.promises.unlink(path.join(dir, filename));
			}
			catch (error) {
				console.error(error);
			}
		}

		await fs.promises.rename(path.join(process.cwd(), dir), path.join('/var/www/html/', dir));

		const hostname = (await spawn_promise('ec2metadata', ['--public-hostname'])).stdout.trim();
		const link = `http://${hostname}/${encodeURIComponent(dir)}/${encodeURIComponent(out_filename)}`;

		return link;
	})().then(on_resolve).catch(on_reject);
});

bot.hears('Статус', async (ctx) => {
	if (!user_map.has(ctx.message.from.id)) {
		await ctx.reply('Список пуст', keyboard);
		return;
	}
	const list_map = user_map.get(ctx.message.from.id);
	let status = null;
	if (status_map.has(ctx.message.from.id)) {
		status = status_map.get(ctx.message.from.id);
	}
	if (status == 'in_progress') {
		await ctx.reply('Обрабатывается список:', keyboard);
	}
	else {
		await ctx.reply('Список:', keyboard);
	}
	for (const [key, video] of list_map.entries()) {
		const inlineKeyboard = Markup.inlineKeyboard([
			Markup.button.callback('Убрать', `remove_${ctx.message.from.id}_${key}`)
		]);
		ctx.reply(video.url, inlineKeyboard);
	}
});

bot.on('message', async (ctx, next) =>  {
	//console.log('bot', ctx.message);
	if (ctx.message.text != null) {
		const text = ctx.message.text.trim();
		let list_map;
		let append_array = [];
		if (user_map.has(ctx.message.from.id)) {
			list_map = user_map.get(ctx.message.from.id);
		}
		else {
			list_map = new Map();
			user_map.set(ctx.message.from.id, list_map);
		}
		if (/^https\:\/\/www\.youtube\.com\/watch\S+$/.test(text)) {
			append_array.push(text);
		}
		else if (ctx.message.entities != null) {
			const entities = ctx.message.entities.filter(entity => entity.type == 'url');
			for (const entity of entities) {
				const {offset} = entity;
				const {length} = entity;
				const url = ctx.message.text.substring(offset, offset + length);
				append_array.push(url);
			}
		}
		if (append_array.length == 0) {
			ctx.reply('Ссылок не найдено', keyboard);
			return next();
		}
		else {
			for (const url of append_array) {
				const key = `${uuidv4()}`;
				list_map.set(key, {url});
				if (append_array.length == 1) {
					const inlineKeyboard = Markup.inlineKeyboard([
					    Markup.button.callback('Убрать', `remove_${ctx.message.from.id}_${key}`)
					]);
					await ctx.reply('Видео добавлено в список', inlineKeyboard);
				}
			}
			if (append_array.length > 1) {
				await ctx.reply(`${append_array.length} видео добавлено в список`, keyboard);
			}
		}
	}
	return next();
});

bot.action(/^remove_(\d+)_(.+)$/, async (ctx) => {
	const user_id = Number(ctx.match[1]);
	const key = ctx.match[2];
	if (!uuidValidate(key)) {
		return;
	}
	if (!user_map.has(user_id)) {
		await ctx.answerCbQuery('Список пуст');
		return;
	}
	let list_map = user_map.get(user_id);
	if (list_map.size == 0) {
		user_map.delete(user_id);
		await ctx.answerCbQuery('Список пуст');
	}
	else if (list_map.has(key)) {
		const video = list_map.get(key);
		list_map.delete(key);
		await ctx.answerCbQuery();
		await ctx.reply(`Удалено из списка: ${video.url}`, keyboard);
	}
	else {
		await ctx.answerCbQuery('Видео отсутствует в списке');
	}
	if (list_map.size == 0) {
		user_map.delete(user_id);
	}
});

(async function () {
	await bot.launch();
})();
