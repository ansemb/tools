import { Command } from "https://deno.land/x/cliffy@v1.0.0-rc.3/command/mod.ts";
import {
  basename,
  extname,
  join,
} from "https://deno.land/std@0.202.0/path/mod.ts";
import { z } from "npm:zod@3";

const FILENAME = basename(new URL("", import.meta.url).pathname).slice(0, -3);
const VERSION = "0.0.1";

const RESOLUTION_MAX_WIDTH = 1024;

const FRAME_FILENAME_EXT = ".png";
const FRAME_FILENAME = `frame-%08d${FRAME_FILENAME_EXT}`;

const ffmpeg = "ffmpeg";
const ffmpeg_args = "-loglevel error -progress - -nostats".split(" ");
const ffprobe = "ffprobe";
const ffprobe_args =
  "-v error -print_format json -show_format -show_streams".split(" ");

const gifski = "gifski";

const FfProbeStream = z.object({
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
});
type FfProbeStream = z.infer<typeof FfProbeStream>;

const FfProbeStreams = z.object({
  streams: z.array(FfProbeStream),
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

async function get_video_resolution(video_path: string) {
  const args = [...ffprobe_args, video_path];

  let cmd: Deno.CommandOutput;
  try {
    cmd = await new Deno.Command(ffprobe, {
      args: args,
    }).output();
  } catch {
    return {
      error: `command not found: '${ffprobe}'. make sure '${ffmpeg}' is installed and available in PATH (${ffprobe} is part of ${ffmpeg}).`,
    };
  }

  if (!cmd.success) {
    const error = decode(cmd.stderr);
    return { error };
  }

  try {
    const json = JSON.parse(decode(cmd.stdout));
    const streams = FfProbeStreams.parse(json);
    const resolution = streams.streams.shift();
    if (!resolution) {
      return {
        error: `unable to retrieve resolution from stream with ${ffprobe}`,
      };
    }

    return { data: resolution };
  } catch (e) {
    return { error: e.message as string };
  }
}

type GenerateFrameProps = {
  video_path: string;
  fps: number;
  temp_path: string;
  resolution: FfProbeStream;
  keep_original_size: boolean;
};

async function generate_frames({
  video_path,
  fps,
  temp_path,
  resolution,
  keep_original_size,
}: GenerateFrameProps) {
  let scaleArg: string | undefined = undefined;

  // TODO: consider both width and height when downscaling
  if (!keep_original_size && resolution.width > RESOLUTION_MAX_WIDTH) {
    scaleArg = `scale=${RESOLUTION_MAX_WIDTH}:-1`;
    console.log(`downscaling to width: ${RESOLUTION_MAX_WIDTH}`);
  }
  const fpsArg = `fps=${fps}`;

  const vfArgs = [scaleArg, fpsArg].filter(Boolean).join(",");
  const ffmpegArgs = [
    ...ffmpeg_args,
    "-i",
    video_path,
    "-vf",
    vfArgs,
    temp_path,
  ];

  console.log(`running cmd:`, ffmpeg, ffmpegArgs.join(" "));

  let process: Deno.ChildProcess;
  try {
    process = new Deno.Command(ffmpeg, {
      args: ffmpegArgs,
      stdout: "piped",
      stderr: "piped",
    }).spawn();
  } catch {
    return {
      error: `command not found: '${ffmpeg}'. make sure '${ffmpeg}' is installed and available from PATH.`,
    };
  }

  for await (const chunk of process.stdout) {
    console.log(decode(chunk));
  }

  let error_msg = "";
  for await (const chunk of process.stderr) {
    error_msg += decode(chunk);
  }

  const { code } = await process.status;

  if (code || error_msg.length > 0) {
    return { error: error_msg };
  }
  return {};
}

type GifProps = {
  temp_dir: string;
  output_path: string;
};

async function create_gif_from_frames({ output_path, temp_dir }: GifProps) {
  console.log(`creating gif from frames...`);
  console.log(`output path: ${output_path}`);

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

  console.log(`current shell: ${shell}`);
  console.log(`running cmd:`, shell, args.join(" "));
  let process: Deno.ChildProcess;

  try {
    process = new Deno.Command(shell, {
      args: args,
      stdout: "piped",
      stderr: "piped",
    }).spawn();
  } catch {
    return {
      error: `command not found: '${ffprobe}'. make sure '${ffmpeg}' is installed and available in PATH (${ffprobe} is part of ${ffmpeg}).`,
    };
  }
  for await (const chunk of process.stdout) {
    await Deno.stdout.write(chunk);
  }

  let error_msg = "";
  for await (const chunk of process.stderr) {
    error_msg += decode(chunk);
  }

  const { code } = await process.status;

  // add newline
  console.log();
  if (code || error_msg.length > 0) {
    return { error: error_msg };
  }

  return {};
}

async function clean_up_temp_dir(temp_dir: string) {
  try {
    console.log(`removing tmp_dir: ${temp_dir}`);
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
    "doesn't downscale and keeps the original size of the video"
  )
  .option("--fps [fps:number]", "number of frames per second (fps)", {
    default: 12,
  })
  .option(
    "-o, --output-path [output-path:string]",
    "output path for generated gif. default to cwd and input filename."
  )
  .arguments("<video-path>")
  .action(async function (options, video_path) {
    const filename_with_ext = basename(video_path);
    const video_filename = filename_with_ext.slice(
      0,
      filename_with_ext.length - extname(filename_with_ext).length
    );

    const output_path =
      (options.outputPath as string | undefined) ?? `${video_filename}.gif`;

    const fps = options.fps as number;

    const { data: resolution, error: res_error } = await get_video_resolution(
      video_path
    );

    if (res_error || !resolution) {
      console.error(res_error);
      Deno.exit(1);
    }
    console.log(
      `video_resolution. width: ${resolution.width}, height: ${resolution.height}`
    );

    const temp_dir = await Deno.makeTempDir();
    const temp_path = join(temp_dir, FRAME_FILENAME);

    console.log(`writing frames to tmp_dir: ${temp_dir}`);

    const { error } = await generate_frames({
      video_path,
      fps,
      temp_path,
      resolution,
      keep_original_size: !!options.originalSize,
    });

    if (error) {
      await clean_up_temp_dir(temp_dir);

      console.error(error);
      Deno.exit(1);
    }
    console.log("finished generating frames.\n");

    const { error: gifError } = await create_gif_from_frames({
      output_path,
      temp_dir,
    });

    await clean_up_temp_dir(temp_dir);

    if (gifError) {
      console.error(gifError);
      Deno.exit(1);
    }
  })
  .parse();
