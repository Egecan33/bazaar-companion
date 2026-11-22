// Always-on-top panel that shows the companion view over the game.
// Build: clang -O2 -fobjc-arc -framework Cocoa -framework WebKit overlay/overlay.m -o overlay/bazaar-overlay
// Run:   overlay/bazaar-overlay [url]   (default http://localhost:4747)
// It only displays the local page; it does not touch the game.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

@interface Overlay : NSObject <NSApplicationDelegate, WKNavigationDelegate, NSWindowDelegate>
@property(strong) NSPanel *panel;
@property(strong) WKWebView *web;
@property(strong) NSURL *url;
@end

@implementation Overlay
- (void)applicationDidFinishLaunching:(NSNotification *)note {
  NSRect s = NSScreen.mainScreen.visibleFrame;
  CGFloat w = 380;
  NSRect frame = NSMakeRect(NSMaxX(s) - w - 8, NSMinY(s) + 8, w, s.size.height - 16);
  self.panel = [[NSPanel alloc] initWithContentRect:frame
      styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskResizable |
                NSWindowStyleMaskNonactivatingPanel | NSWindowStyleMaskUtilityWindow |
                NSWindowStyleMaskFullSizeContentView
      backing:NSBackingStoreBuffered defer:NO];
  self.panel.title = @"Bazaar Companion";
  self.panel.level = NSStatusWindowLevel;  // above normal and full-screen windows
  self.panel.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorFullScreenAuxiliary;
  self.panel.hidesOnDeactivate = NO;
  self.panel.floatingPanel = YES;
  self.panel.becomesKeyOnlyIfNeeded = YES;  // clicking it does not take focus from the game
  self.panel.movableByWindowBackground = YES;
  // See-through window: the page paints a faint tint, text stays fully opaque.
  self.panel.titlebarAppearsTransparent = YES;
  self.panel.titleVisibility = NSWindowTitleHidden;
  self.panel.opaque = NO;
  self.panel.backgroundColor = NSColor.clearColor;
  self.panel.hasShadow = NO;
  self.panel.sharingType = NSWindowSharingNone;  // ask macOS to leave it out of screen captures
  self.panel.minSize = NSMakeSize(300, 240);
  [self.panel setFrameAutosaveName:@"BazaarCompanionOverlay"];  // remembers where you put it
  self.panel.delegate = self;

  self.web = [[WKWebView alloc] initWithFrame:self.panel.contentView.bounds];
  self.web.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  self.web.navigationDelegate = self;
  [self.web setValue:@NO forKey:@"drawsBackground"];
  [self.panel.contentView addSubview:self.web];
  [self.panel orderFrontRegardless];
  // Clicks pass through to the game. Only the top strip (drag, close, gold box) takes the mouse.
  self.panel.ignoresMouseEvents = YES;
  [NSTimer scheduledTimerWithTimeInterval:0.1 repeats:YES block:^(NSTimer *t) {
    NSPoint m = NSEvent.mouseLocation;
    NSRect f = self.panel.frame;
    NSRect strip = NSMakeRect(NSMinX(f), NSMaxY(f) - 64, f.size.width, 64);
    BOOL dragging = (NSEvent.pressedMouseButtons & 1) && !self.panel.ignoresMouseEvents;
    self.panel.ignoresMouseEvents = !(NSPointInRect(m, strip) || dragging);
  }];
  [self.web loadRequest:[NSURLRequest requestWithURL:self.url]];
}

// The server may still be starting: retry until the page loads.
- (void)webView:(WKWebView *)w didFailProvisionalNavigation:(WKNavigation *)n withError:(NSError *)e {
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), dispatch_get_main_queue(), ^{
    [w loadRequest:[NSURLRequest requestWithURL:self.url]];
  });
}

- (void)windowWillClose:(NSNotification *)note { [NSApp terminate:nil]; }
@end

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    NSApplication *app = NSApplication.sharedApplication;
    Overlay *d = [Overlay new];
    d.url = [NSURL URLWithString:argc > 1 ? @(argv[1]) : @"http://localhost:4747/?overlay=1"];
    app.delegate = d;
    [app setActivationPolicy:NSApplicationActivationPolicyAccessory];  // no Dock icon
    [app run];
  }
  return 0;
}
