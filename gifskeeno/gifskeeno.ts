import { Command } from "https://deno.land/x/cliffy@v1.0.0-rc.3/command/mod.ts";
import {
  basename,
  extname,
  join,
} from "https://deno.land/std@0.202.0/path/mod.ts";
import { z } from "npm:zod@3";
import ProgressBar from "https://deno.land/x/progress@v1.3.9/mod.ts";

const FILENAME = basename(new URL("", import.meta.url).pathname).slice(0, -3);
const VERSION = "0.0.1";

const RESOLUTION_MAX_WIDTH = 1024;

const FRAME_FILENAME_EXT = ".png";
const FRAME_FILENAME = `frame-%08d${FRAME_FILENAME_EXT}`;

const ffmpeg = "ffmpeg";
const ffmpeg_args_base = "-loglevel error -progress - -nostats".split(" ");
const ffprobe = "ffprobe";

// -v error: The -v option sets the logging level for the tool. Here, it's set to error, which means only error messages will be displayed. This helps reduce the verbosity of the tool's output.
// -select_streams v:0: This option selects which streams from the input file you're interested in. v:0 specifies the first video stream. (In multimedia files, there can be multiple streams—e.g., audio, video, subtitles, etc.)
// -count_packets: This option tells ffmpeg to count the packets in the selected stream. Packets are the pieces into which data is divided for transmission over a network or for storage.
// -show_entries stream=width,height,nb_read_packets: This is an instruction to show specific data entries related to the stream:
//     width: Width of the video in pixels.
//     height: Height of the video in pixels.
//     nb_read_packets: The number of packets read for the selected stream.
// -show_entries packet=pts_time: This option indicates that for each packet in the stream, the presentation timestamp (pts_time) should be displayed. The presentation timestamp determines when a decoder should present a frame.
// -of json: The output format for the data. Here, it's set to json, meaning the extracted data will be formatted as a JSON document.
const ffprobe_args =
  "-v error -select_streams v:0 -count_packets -show_entries stream=width,height,nb_read_packets -show_entries packet=pts_time -of json".split(
    " ",
  );

const gifski = "gifski";

const progress = new ProgressBar({
  total: 1,
  complete: "=",
  incomplete: "-",
  display: "creating GIF: :time [:bar] :percent",
});

const StreamInfo = z.object({
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
  nb_read_packets: z.string(),
});
type StreamInfo = z.infer<typeof StreamInfo>;

const Packet = z.object({
  pts_time: z.string(),
});
type Packet = z.infer<typeof Packet>;

const FfProbeStreams = z.object({
  packets: z.array(Packet),
  streams: z.array(StreamInfo),
});

const td = new TextDecoder();

function decode(array: Uint8Array) {
  return td.decode(array);
}

const shell =
  Deno.build.os === "windows"
    ? "pwsh"
    : Deno.build.os === "darwin"
    ? "zsh"
    : "bash";

type ExecuteCommandProps = {
  cmd: string;
  args: string[];
  cmd_error_msg?: string;
  process_stdout_chunk: (chunk: Uint8Array) => void | Promise<void>;
};

type Result<T, E extends string> =
  | {
      data: T;
      error?: null;
    }
  | {
      data?: null;
      error: E;
    };

async function execute_command_piped({
  cmd,
  args,
  process_stdout_chunk,
}: ExecuteCommandProps): Promise<Result<undefined, string>> {
  let process: Deno.ChildProcess;
  try {
    process = new Deno.Command(cmd, {
      args: args,
      stdout: "piped",
      stderr: "piped",
    }).spawn();
  } catch {
    return {
      error: `command not found: '${cmd}'.`,
    };
  }

  for await (const chunk of process.stdout) {
    await process_stdout_chunk(chunk);
  }

  let error_msg = "";
  for await (const chunk of process.stderr) {
    error_msg += decode(chunk);
  }

  const { code } = await process.status;

  if (code !== 0 || error_msg.length > 0) {
    return { error: error_msg };
  }

  return { data: undefined };
}

type VideoInfo = { stream: StreamInfo; last_packet: Packet };

async function get_video_info(
  video_path: string,
): Promise<Result<VideoInfo, string>> {
  const args = [...ffprobe_args, video_path];

  let process: Deno.CommandOutput;
  try {
    process = await new Deno.Command(ffprobe, {
      args: args,
    }).output();
  } catch {
    return {
      error: `command not found: '${ffprobe}'. make sure '${ffmpeg}' is installed and available in PATH (${ffprobe} is part of ${ffmpeg}).`,
    };
  }

  if (!process.success) {
    const error = decode(process.stderr);
    return { error };
  }

  try {
    const json = JSON.parse(decode(process.stdout));
    const info = FfProbeStreams.parse(json);
    const stream = info.streams.shift();
    if (!stream) {
      return {
        error: `unable to retrieve resolution from stream with ${ffprobe}`,
      };
    }
    const last_packet = info.packets.pop();
    if (!last_packet) {
      return {
        error: `unable to retrieve packets from stream with ${ffprobe}`,
      };
    }

    return { data: { stream, last_packet } };
  } catch (e) {
    return { error: e.message as string };
  }
}

type GenerateFrameProps = {
  video_path: string;
  fps: number;
  temp_path: string;
  info: VideoInfo;
  keep_original_size: boolean;
};

async function generate_frames({
  video_path,
  fps,
  temp_path,
  info,
  keep_original_size,
}: GenerateFrameProps) {
  let scale_arg: string | undefined = undefined;

  const total_frames = parseInt(info.stream.nb_read_packets);

  const duration_str = info.last_packet.pts_time;
  const duration = duration_str ? parseFloat(duration_str) : undefined;

  // let progress: ProgressBar | undefined = undefined;
  let total_generated_frames: number | undefined = undefined;

  if (!isNaN(total_frames) && duration) {
    let original_fps: number | undefined = undefined;
    original_fps = total_frames / duration;

    total_generated_frames = Math.floor(total_frames / (original_fps / fps));
  }

  // TODO: consider both width and height when downscaling
  if (!keep_original_size && info.stream.width > RESOLUTION_MAX_WIDTH) {
    scale_arg = `scale=${RESOLUTION_MAX_WIDTH}:-1`;
  }

  const fps_arg = `fps=${fps}`;

  const vf_args = [scale_arg, fps_arg].filter(Boolean).join(",");
  const ffmpeg_args = [
    ...ffmpeg_args_base,
    "-i",
    video_path,
    "-vf",
    vf_args,
    temp_path,
  ];

  const res = await execute_command_piped({
    cmd: ffmpeg,
    args: ffmpeg_args,
    process_stdout_chunk: (chunk) => {
      const data = decode(chunk);

      const match = data.match(/frame=(\d+)/);
      const frame_value = match ? parseInt(match[1]) : undefined;

      if (frame_value && !isNaN(frame_value)) {
        const p = frame_value / total_frames / 2;
        progress.render(p);
      }
    },
  });

  // halfway
  progress.render(0.5);

  return res;
}

type GifProps = {
  temp_dir: string;
  output_path: string;
};

async function create_gif_from_frames({ output_path, temp_dir }: GifProps) {
  const framesPath = join(temp_dir, `frame-*${FRAME_FILENAME_EXT}`);
  const gifskiCmd = [
    gifski,
    "-o",
    output_path,
    "--quality",
    "80",
    framesPath,
  ].join(" ");
  // TODO: powershell
  const args = ["-c", gifskiCmd];

  const total_frames = [...Deno.readDirSync(temp_dir)].filter(Boolean).length;

  const regex_frame = /Frame (\d+) \/ \d+/g;
  const res = await execute_command_piped({
    cmd: shell,
    args: args,
    process_stdout_chunk: (chunk) => {
      const line = decode(chunk);
      // matches 33 in:
      // 358KB GIF; Frame 33 / 69  ######_..............  0s
      const match = regex_frame.exec(line);
      const frame_str = match && match.pop();
      const frame = frame_str ? parseInt(frame_str) : undefined;

      if (frame && !isNaN(frame)) {
        const p = frame / total_frames / 2;

        progress.render(0.5 + Math.min(p, 0.5));
      }
    },
  });
  // complete
  progress.render(1);
  return res;
}

async function clean_up_temp_dir(temp_dir: string) {
  try {
    await Deno.remove(temp_dir, { recursive: true });
  } catch (e) {
    console.error(`unable to clean up temp_dir: ${temp_dir}. error: ${e}`);
  }
}

await new Command()
  .name(FILENAME)
  .version(VERSION)
  .description("Downloads deno binaries into a specified output folder.")
  .option(
    "--original-size [original-size:boolean]",
    "doesn't downscale and keeps the original size of the video",
  )
  .option("--fps [fps:number]", "number of frames per second (fps)", {
    default: 12,
  })
  .option(
    "-o, --output-path [output-path:string]",
    "output path for generated gif. default to cwd and input filename.",
  )
  .arguments("<video-path>")
  .action(async function (options, video_path) {
    const filename_with_ext = basename(video_path);
    const video_filename = filename_with_ext.slice(
      0,
      filename_with_ext.length - extname(filename_with_ext).length,
    );

    const output_path =
      (options.outputPath as string | undefined) ?? `${video_filename}.gif`;

    const fps = options.fps as number;

    const { data: info, error: res_error } = await get_video_info(video_path);

    if (res_error || !info) {
      console.error(res_error);
      Deno.exit(1);
    }

    const temp_dir = await Deno.makeTempDir();
    const temp_path = join(temp_dir, FRAME_FILENAME);

    const { error } = await generate_frames({
      video_path,
      fps,
      temp_path,
      info,
      keep_original_size: !!options.originalSize,
    });

    if (error) {
      await clean_up_temp_dir(temp_dir);

      console.error(error);
      Deno.exit(1);
    }

    const { error: gifError } = await create_gif_from_frames({
      output_path,
      temp_dir,
    });

    await clean_up_temp_dir(temp_dir);

    if (gifError) {
      console.error(gifError);
      Deno.exit(1);
    }
    console.log(`${FILENAME} created ${output_path}`);
  })
  .parse();
