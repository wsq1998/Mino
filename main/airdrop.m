// Mio · 一键 AirDrop 投送原生辅助程序（v2.7）
// 为什么必须用原生 helper：osascript 是 CLI 进程、osacompile 生成的 applet 在 on run 返回后立即退出，
//   两者都没有常驻的 NSApplication 事件循环 —— NSSharingService 的分享面板会随之被销毁，用户永远看不到面板（已实证）。
//   本程序用 [NSApp run] 跑真正的 run loop，直到投送成功 / 失败 / 面板关闭才退出。
// 用法：airdrop-helper <目标文件绝对路径> <诊断日志绝对路径>
//   退出码：0 正常；2 参数缺失。helper 在面板打开期间持续运行属预期行为（回调较晚返回，不是卡死）。
#import <Cocoa/Cocoa.h>

static NSString *gLogPath = nil;

// 追加一行到日志文件（任何异常都静默 —— 日志只是诊断，绝不能影响投送本身）
static void L(NSString *msg) {
  if (!gLogPath) return;
  @try {
    NSString *line = [NSString stringWithFormat:@"%@ [helper] %@\n", [NSDate date], msg];
    NSFileManager *fm = [NSFileManager defaultManager];
    if (![fm fileExistsAtPath:gLogPath]) {
      [fm createFileAtPath:gLogPath contents:nil attributes:nil];
    }
    NSFileHandle *fh = [NSFileHandle fileHandleForWritingAtPath:gLogPath];
    [fh seekToEndOfFile];
    [fh writeData:[line dataUsingEncoding:NSUTF8StringEncoding]];
    [fh closeFile];
  } @catch (NSException *e) {}
}

@interface MioShareDelegate : NSObject <NSSharingServiceDelegate>
@end

@implementation MioShareDelegate
- (void)sharingService:(NSSharingService *)service didShareItems:(NSArray *)items {
  L(@"delegate didShareItems（投送完成）→ 退出");
  [NSApp terminate:nil];
}
- (void)sharingService:(NSSharingService *)service
    didFailToShareItems:(NSArray *)items
                  error:(NSError *)error {
  L([NSString stringWithFormat:@"delegate didFail: %@",
                             error.localizedDescription ? error.localizedDescription : error]);
  [NSApp terminate:nil];
}
@end

// 面板是否已出现过：出现过又消失 = 用户关闭 / 投送结束（NSSharingServiceDelegate 取消时不回调，只能轮询判定）
static BOOL gPanelSeen = NO;

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc > 2) gLogPath = [NSString stringWithUTF8String:argv[2]];
    NSString *path = argc > 1 ? [NSString stringWithUTF8String:argv[1]] : @"";
    if (!path.length) {
      L(@"缺少目标路径参数，退出");
      return 2;
    }

    // accessory：面板能正常弹出，且不会在用户 Dock 里留下图标（已实证两种策略均可弹面板）
    NSApplication *app = [NSApplication sharedApplication];
    [app setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [app activateIgnoringOtherApps:YES];

    L([NSString stringWithFormat:@"start path=%@", path]);

    NSURL *url = [NSURL fileURLWithPath:path];
    NSSharingService *svc = [NSSharingService sharingServiceNamed:NSSharingServiceNameSendViaAirDrop];
    MioShareDelegate *delegate = [[MioShareDelegate alloc] init];
    svc.delegate = delegate;

    L([NSString stringWithFormat:@"svc=%@ canPerform=%d", svc ? @"OK" : @"nil",
                               (int)[svc canPerformWithItems:@[ url ]]]);

    [svc performWithItems:@[ url ]];

    // 一次窗口快照（面板是异步创建的，稍等再取）：确认分享面板到底有没有画出来
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.7 * NSEC_PER_SEC)),
                   dispatch_get_main_queue(), ^{
                     NSArray<NSWindow *> *ws = [NSApp windows];
                     NSMutableString *ms = [NSMutableString string];
                     for (NSWindow *w in ws) {
                       [ms appendFormat:@"[%@ visible=%d title=%@]", NSStringFromClass([w class]),
                                                 (int)[w isVisible], [w title]];
                     }
                     L([NSString stringWithFormat:@"windows=%lu %@", (unsigned long)[ws count], ms]);
                   });

    // 取消处理：0.5s 轮询窗口，出现过 "AirDrop" 窗口后又消失 → 判定面板关闭 → 退出
    [NSTimer scheduledTimerWithTimeInterval:0.5 repeats:YES block:^(NSTimer *t) {
      BOOL airVisible = NO;
      for (NSWindow *w in [NSApp windows]) {
        if ([[w title] isEqualToString:@"AirDrop"] && [w isVisible]) { airVisible = YES; break; }
      }
      if (airVisible && !gPanelSeen) {
        gPanelSeen = YES;
        L(@"panel 出现 title=AirDrop visible=1");
      } else if (!airVisible && gPanelSeen) {
        L(@"panel closed（用户关闭或投送结束）→ 退出");
        [NSApp terminate:nil];
      }
    }];

    // 硬兜底：无论如何 300s 内退出，避免留下僵尸进程
    [NSTimer scheduledTimerWithTimeInterval:300 repeats:NO block:^(NSTimer *t) {
      L(@"300s 兜底超时 → 退出");
      [NSApp terminate:nil];
    }];

    [app run];
    L(@"app run returned，退出");
  }
  return 0;
}
