package top.emiraen.stronghold;

import android.content.Context;
import android.content.res.AssetFileDescriptor;
import android.os.Build;
import fi.iki.elonen.NanoHTTPD;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

final class AssetServer extends NanoHTTPD {
    static final int PORT = 18647;
    static final String ORIGIN = "http://127.0.0.1:" + PORT;
    static final String MAIN = "https://super.emiraen.top:23331";
    static final String SECONDARY = "https://emiraen.top";
    private static AssetServer instance;
    private final Context context;
    private final JSONObject files;
    private final JSONObject aliases;
    private final String token = UUID.randomUUID().toString();

    private AssetServer(Context context) throws Exception {
        super("127.0.0.1", PORT);
        this.context = context.getApplicationContext();
        try (InputStream input = context.getAssets().open("bundle-index.json")) {
            JSONObject index = new JSONObject(readText(input));
            files = index.getJSONObject("files");
            aliases = index.getJSONObject("aliases");
        }
    }
    static synchronized AssetServer ensure(Context context) throws Exception {
        if (instance == null) {
            AssetServer next = new AssetServer(context);
            next.start(SOCKET_READ_TIMEOUT, false);
            instance = next;
        }
        return instance;
    }
    String entryUrl() { return ORIGIN + "/?native=" + token; }
    boolean trusted(String origin) { return ORIGIN.equals(origin); }
    private static String readText(InputStream input) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] block = new byte[16384]; int count;
        while ((count = input.read(block)) != -1) output.write(block, 0, count);
        return output.toString("UTF-8");
    }
    private Response fail(Response.Status status, String message) {
        return newFixedLengthResponse(status, "text/plain; charset=utf-8", message);
    }
    @Override public Response serve(IHTTPSession session) {
        String host = session.getHeaders().get("host");
        if (!("127.0.0.1:" + PORT).equals(host) && !("localhost:" + PORT).equals(host)) return fail(Response.Status.FORBIDDEN, "Forbidden host");
        String path = session.getUri();
        if (path == null || !path.startsWith("/") || path.contains("\\") || path.contains("\u0000") || Arrays.asList(path.split("/")).contains("..")) return fail(Response.Status.FORBIDDEN, "Invalid path");
        String origin = session.getHeaders().get("origin");
        if (origin != null && !trusted(origin)) return fail(Response.Status.FORBIDDEN, "Invalid origin");
        try {
            if (session.getMethod() != Method.GET && session.getMethod() != Method.HEAD && !path.startsWith("/api/")) return fail(Response.Status.METHOD_NOT_ALLOWED, "Method not allowed");
            if (path.equals("/__apk/probe") || path.equals("/__apk/ready")) {
                String supplied = session.getParms().get("token");
                if (!token.equals(supplied)) return fail(Response.Status.FORBIDDEN, "Invalid token");
                return newFixedLengthResponse("ok");
            }
            if (path.equals("/api/servers")) {
                JSONObject directory = new JSONObject();
                try { directory = new JSONObject(readText(remote(MAIN + "/api/servers").getInputStream())); } catch (Exception ignored) {}
                if (!directory.has("servers")) {
                    JSONArray servers = new JSONArray();
                    servers.put(new JSONObject().put("id", "main").put("name", "华东一服").put("url", MAIN).put("load", "unknown"));
                    servers.put(new JSONObject().put("id", "secondary").put("name", "华南二服").put("url", SECONDARY).put("load", "unknown"));
                    directory.put("current", "main").put("servers", servers);
                }
                JSONArray servers = directory.getJSONArray("servers");
                for (int i = 0; i < servers.length(); i++) if ("main".equals(servers.getJSONObject(i).optString("id"))) servers.getJSONObject(i).put("url", ORIGIN);
                return newFixedLengthResponse(Response.Status.OK, "application/json", directory.toString());
            }
            String plain = path.replaceFirst("/~[^/]+/", "/");
            String resolved = aliases.optString(plain, plain);
            if (resolved.equals("/")) resolved = "/index.html";
            JSONObject file = files.optJSONObject(resolved);
            if (file != null) return local(session, resolved, file);
            if (plain.startsWith("/api/profile-service") || plain.startsWith("/admin")) return fail(Response.Status.FORBIDDEN, "Forbidden endpoint");
            if (plain.startsWith("/api/") || plain.startsWith("/p/") || plain.startsWith("/packs/") || plain.startsWith("/plugins/") || plain.startsWith("/cs/") || plain.startsWith("/vs/") || plain.equals("/announcement.json") || plain.equals("/healthz")) return proxy(session, path);
            return fail(Response.Status.NOT_FOUND, "Not found");
        } catch (Exception error) {
            return fail(Response.Status.INTERNAL_ERROR, "Local client request failed");
        }
    }
    private HttpURLConnection remote(String url) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(12000); connection.setReadTimeout(20000);
        connection.setInstanceFollowRedirects(false);
        connection.setRequestProperty("User-Agent", "Stronghold-Android/20261025");
        connection.setRequestProperty("Accept-Encoding", "identity");
        return connection;
    }
    private Response proxy(IHTTPSession session, String path) throws Exception {
        String query = session.getQueryParameterString();
        HttpURLConnection connection = remote(MAIN + path + (query == null ? "" : "?" + query));
        connection.setRequestMethod(session.getMethod().name());
        for (String name : new String[]{"content-type", "accept", "range", "authorization", "cookie"}) {
            String value = session.getHeaders().get(name); if (value != null) connection.setRequestProperty(name, value);
        }
        connection.setRequestProperty("Origin", MAIN);
        if (session.getMethod() == Method.POST || session.getMethod() == Method.PUT) {
            String size = session.getHeaders().get("content-length");
            long length = Long.parseLong(size == null ? "0" : size);
            if (length > 1024 * 1024) return fail(Response.Status.PAYLOAD_TOO_LARGE, "Request too large");
            connection.setDoOutput(true); connection.setFixedLengthStreamingMode((int) length);
            try (OutputStream out = connection.getOutputStream()) {
                byte[] block = new byte[16384]; long left = length;
                while (left > 0) { int count = session.getInputStream().read(block, 0, (int)Math.min(left, block.length)); if (count < 0) break; out.write(block, 0, count); left -= count; }
            }
        }
        int code = connection.getResponseCode();
        Response.Status status = Response.Status.lookup(code);
        InputStream stream = code >= 400 ? connection.getErrorStream() : connection.getInputStream();
        if (stream == null) stream = new ByteArrayInputStream(new byte[0]);
        final InputStream input = stream;
        InputStream closing = new FilterInputStream(input) { @Override public void close() throws IOException { try { super.close(); } finally { connection.disconnect(); } } };
        Response response = newChunkedResponse(status == null ? Response.Status.INTERNAL_ERROR : status, connection.getContentType(), closing);
        response.addHeader("Cache-Control", "no-store");
        return response;
    }
    private Response local(IHTTPSession session, String path, JSONObject file) throws Exception {
        long total = file.getLong("bytes"), start = 0, end = total - 1;
        String range = session.getHeaders().get("range"); boolean partial = false;
        if (range != null && range.startsWith("bytes=") && !range.contains(",")) {
            String[] parts = range.substring(6).split("-", -1);
            if (parts.length == 2) {
                if (parts[0].isEmpty()) start = Math.max(0, total - Long.parseLong(parts[1]));
                else { start = Long.parseLong(parts[0]); if (!parts[1].isEmpty()) end = Math.min(end, Long.parseLong(parts[1])); }
                if (start < 0 || start >= total || end < start) { Response r = fail(Response.Status.RANGE_NOT_SATISFIABLE, "Invalid range"); r.addHeader("Content-Range", "bytes */" + total); return r; }
                partial = true;
            }
        }
        AssetFileDescriptor descriptor = context.getAssets().openFd("site" + path);
        InputStream asset;
        try { asset = descriptor.createInputStream(); }
        catch (IOException error) { descriptor.close(); throw error; }
        InputStream input = new FilterInputStream(asset) {
            @Override public void close() throws IOException { try { super.close(); } finally { descriptor.close(); } }
        };
        try {
            long skipped = 0;
            while (skipped < start) { long step = input.skip(start - skipped); if (step <= 0) throw new EOFException(); skipped += step; }
        } catch (IOException error) { input.close(); throw error; }
        long length = end - start + 1;
        Response response = newFixedLengthResponse(partial ? Response.Status.PARTIAL_CONTENT : Response.Status.OK, file.getString("mime"), input, length);
        response.addHeader("Accept-Ranges", "bytes");
        response.addHeader("Cache-Control", "no-cache");
        response.addHeader("X-Content-Type-Options", "nosniff");
        if (partial) response.addHeader("Content-Range", "bytes " + start + "-" + end + "/" + total);
        return response;
    }
}
