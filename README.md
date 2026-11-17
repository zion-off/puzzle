# the puzzle

one big jigsaw puzzle, shared by everyone. anyone can take a piece out.

## how it works

**take a piece.** it downloads as a png. that file *is* the piece. its spot in the puzzle stays empty until someone brings it back.

**bring it back.** drop your piece on the page any time. it flies to where it belongs, and you can put it back in or keep holding it.

**give it away.** wrap your piece as a gift and send the link. whoever opens it first gets the piece. links never expire, so a gift can sit unopened for years.

**copies are ghosts.** you can copy the file, but only the newest one counts. older copies still open, as ghosts, and the piece remembers seeing them.

**pieces remember.** every take, gift and return is written into the piece's own pixels, signed so it can't be faked. memory is small, so the oldest moments slowly fade.

**pieces wear out.** like real cardboard. every hand-off rubs a little print off the edges, knob tips and corners first, and now and then the print peels or the piece gets bent. time does its part too: the longer a piece stays out of the puzzle, the more it yellows, and it might pick up a stain. after ten or so owners a piece looks well loved.

**lose the file and the piece is gone.** there are no accounts and no backups. the spot stays empty forever.

## under the hood

### what's inside a piece

every piece is a 206 × 206 png: one grid cell plus room for its tabs. hidden inside it is a small record:

- which puzzle and which piece it is
- a version number (`seq`) that goes up every time the piece changes hands
- how many owners it has had
- a random 16-byte secret, the piece's "key"
- a list of events: taken, put back, wrapped as a gift, gift opened, ghost sighted, each with a timestamp
- a signature over all of the above

no names, emails or ip addresses. an owner is just a moment in time.

### where it hides

the record is written into the least significant bit of the red, green and blue channels of every fully opaque pixel, row by row. changing the last bit of a colour value shifts it by 1 out of 255, which you can't see. a fresh piece has room for about 5,900 bytes, or roughly a thousand events.

when the record no longer fits, the oldest events are dropped first. the piece slowly forgets where it's been.

### how it's signed

the server holds one ed25519 private key. when it writes a piece, it signs the record together with a hash of the visible picture, with all the hidden bits zeroed out. so:

- edit the history and the signature breaks
- paint over the picture and the signature breaks
- only the server can make a valid piece

any re-save that changes pixels, like a jpeg export, a screenshot or a resize, destroys the record. the png itself is the piece.

### who owns it right now

copying a file is free, so the signature alone can't say who holds a piece. for that, the server keeps one tiny row per piece: its current `seq` and a hash of the current secret. while a piece is out in the world, that row is all the server has. it never stores the secret, and the history exists only in your file.

when you bring a piece back, the server checks the signature, then compares the `seq` and the secret against that row:

- **both match:** you hold the real piece
- **anything else:** it's an old copy, a ghost. the server notes the sighting, and the next time the real piece changes hands, the sighting is written into its memory

every hand-off issues a new secret and bumps `seq`, so every older copy turns into a ghost at that moment. if two people bring back the same file, the first one wins.

### gifts

wrapping a piece hands it back to the server and bumps its `seq`, so your file becomes a keepsake. you get a link with a random token. the server stores only a hash of the token, so the link itself is the piece. the first person to open it gets a freshly signed file with a new secret.

### wear

wear is applied to the real pixels and is modelled on a real jigsaw piece: a thin printed paper layer glued onto board. it comes in two kinds. handling happens every time a piece is handed to someone. print rubs off the edges in patches, most at knob tips and corners where fingers and neighbours touch, showing the white paper underneath. tips soften, the gloss goes matte in places, the print sometimes lifts and peels near an edge, and once in a while the piece gets bent and the print cracks. about ten hand-offs make a piece look well worn. age is added when a piece comes back in, either returned or wrapped as a gift, and depends on how long it was out. the print slowly yellows, and long stays can leave a stain or another peel. the time comes from the signed record, so nobody can fake it. the order is always read the record, add wear, then write the record. that way the wear can never damage the history. softened tips turn a little see-through and can't hold data anymore, so a well-loved piece also has a bit less room to remember.

### the board

the whole picture is one image, and the piece shapes come from a fixed random seed, so your browser draws the puzzle itself. the server only says which pieces are missing. pieces that have been passed around are drawn from their stored files, wear and all.

it runs entirely on cloudflare: a worker for the api, one durable object that tracks who holds what, and an r2 bucket for pieces sitting in the puzzle.

developing or deploying it yourself? see [docs/development.md](docs/development.md).
